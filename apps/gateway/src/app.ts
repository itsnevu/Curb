import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { evaluate } from "@curb/policy-engine";
import type { Context, Decision, Policy, RunStateStore } from "@curb/shared";
import { NULL_SINK, type AuditSink } from "./audit.js";
import { errorBody, statusForDecision } from "./errors.js";
import { PriceTable } from "./pricing.js";
import {
  StreamUsageAccumulator,
  detectProvider,
  extractUsage,
  isStreaming,
  messagesOf,
  sanitizeHeaders,
  upstreamFor,
  type Provider,
  type Usage,
} from "./providers.js";
import { signatureOf } from "./signature.js";

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  json?: unknown;
  stream?: NodeJS.ReadableStream;
}

export interface GatewayDeps {
  store: RunStateStore;
  loadPolicies: () => Promise<Policy[]>;
  forward: (
    url: string,
    headers: Record<string, string>,
    body: unknown,
    streaming: boolean,
  ) => Promise<UpstreamResponse>;
  audit?: AuditSink;
  prices?: PriceTable;
  failMode?: "open" | "closed";
  /** Batas tunggu THROTTLE sebelum ditolak saja. */
  maxThrottleMs?: number;
  now?: () => number;
  logger?: boolean;
}

export function buildApp(deps: GatewayDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });
  const audit = deps.audit ?? NULL_SINK;
  const prices = deps.prices ?? new PriceTable();
  const failMode = deps.failMode ?? "closed";
  const now = deps.now ?? Date.now;
  const maxThrottleMs = deps.maxThrottleMs ?? 5_000;

  app.get("/health", async () => ({ ok: true, service: "curb-gateway" }));

  app.post("/v1/*", async (req, reply) => {
    const headers = req.headers as Record<string, unknown>;
    const runId = (headers["x-curb-run-id"] as string) || randomUUID();
    const projectId = headers["x-curb-project"] as string | undefined;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const provider = detectProvider(req.url, headers);
    const streaming = isStreaming(body);
    const t = now();

    // Window di-update SEBELUM evaluate: policy melihat call ini termasuk hitungan.
    const [sigWindow, callTimestamps] = await Promise.all([
      deps.store.pushWindow(runId, "sigWindow", signatureOf(messagesOf(body)), 20),
      deps.store.pushWindow(runId, "callTimestamps", t, 200),
    ]);
    const state = await deps.store.get(runId);
    state.sigWindow = sigWindow as string[];
    state.callTimestamps = callTimestamps as number[];

    const ctx: Context = {
      kind: "llm_call",
      runId,
      projectId,
      model: body.model as string | undefined,
      env: process.env.NODE_ENV,
      now: t,
    };

    const decision = await decide(ctx, state, deps, failMode, req.log);
    const policyType = decision.policyId
      ? (await safePolicies(deps)).find((p) => p.id === decision.policyId)?.type
      : undefined;

    reply.header("x-curb-run-id", runId);
    reply.header("x-curb-cost-usd", state.costUsd.toFixed(6));

    if (decision.effect === "DENY") {
      emit(audit, ctx, decision, state, t);
      reply.header("x-curb-policy", decision.policyId ?? "unknown");
      return reply.code(statusForDecision(decision, policyType)).send(errorBody(provider, decision));
    }

    if (decision.effect === "THROTTLE") {
      const waitMs = decision.retryAfterMs ?? 0;
      emit(audit, ctx, decision, state, t);
      if (waitMs > maxThrottleMs) {
        reply.header("retry-after", Math.ceil(waitMs / 1000));
        reply.header("x-curb-policy", decision.policyId ?? "unknown");
        return reply.code(429).send(errorBody(provider, decision));
      }
      await sleep(waitMs);
    }

    const upstreamHeaders = sanitizeHeaders(headers);
    const target = `${upstreamFor(provider)}${req.url}`;
    const res = await deps.forward(target, upstreamHeaders, body, streaming);

    for (const [k, v] of Object.entries(res.headers)) {
      if (k.toLowerCase() === "content-length" || v === undefined) continue;
      reply.header(k, v);
    }

    if (streaming && res.stream) {
      emit(audit, ctx, { effect: "ALLOW" }, state, t);
      return reply.code(res.status).send(
        meterStream(res.stream, async (usage) => {
          await settle(deps, runId, body.model as string | undefined, usage, prices);
        }),
      );
    }

    const usage = extractUsage(res.json);
    const after = await settle(deps, runId, body.model as string | undefined, usage, prices);
    reply.header("x-curb-cost-usd", after.costUsd.toFixed(6));
    reply.header("x-curb-tokens", String(after.tokens));
    emit(audit, ctx, { effect: "ALLOW" }, after, t);
    return reply.code(res.status).send(res.json);
  });

  return app;
}

async function decide(
  ctx: Context,
  state: Awaited<ReturnType<RunStateStore["get"]>>,
  deps: GatewayDeps,
  failMode: "open" | "closed",
  log: { error: (o: unknown, m: string) => void },
): Promise<Decision> {
  try {
    return evaluate(ctx, await deps.loadPolicies(), state);
  } catch (err) {
    log.error({ err }, "policy evaluation failed");
    return failMode === "open"
      ? { effect: "ALLOW", reason: "policy engine unavailable (fail-open)" }
      : { effect: "DENY", policyId: "curb_fail_closed", reason: "policy engine unavailable (fail-closed)" };
  }
}

async function safePolicies(deps: GatewayDeps): Promise<Policy[]> {
  try {
    return await deps.loadPolicies();
  } catch {
    return [];
  }
}

/** Terapkan usage ke state setelah call sukses. */
async function settle(
  deps: GatewayDeps,
  runId: string,
  model: string | undefined,
  usage: Usage,
  prices: PriceTable,
) {
  return deps.store.bump(runId, {
    tokens: usage.totalTokens,
    costUsd: prices.costUsd(model, usage),
    steps: 1,
  });
}

/** Teruskan stream apa adanya sambil menghitung usage dari SSE. */
function meterStream(source: NodeJS.ReadableStream, onDone: (u: Usage) => Promise<void>) {
  const acc = new StreamUsageAccumulator();
  const out = new PassThrough();
  source.on("data", (chunk: Buffer) => {
    acc.push(chunk.toString("utf8"));
    out.write(chunk);
  });
  source.on("end", () => {
    out.end();
    void onDone(acc.result());
  });
  source.on("error", (err) => out.destroy(err as Error));
  return out;
}

function emit(
  audit: AuditSink,
  ctx: Context,
  decision: Decision,
  state: { costUsd: number; tokens: number },
  ts: number,
) {
  audit.emit({
    runId: ctx.runId,
    projectId: ctx.projectId,
    ts,
    kind: ctx.kind,
    effect: decision.effect,
    policyId: decision.policyId,
    reason: decision.reason,
    model: ctx.model,
    costUsdSnapshot: state.costUsd,
    tokensSnapshot: state.tokens,
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export type { Provider };
