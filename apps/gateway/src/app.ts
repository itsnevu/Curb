import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { costWindowKeys, evaluate, runKey } from "@curb/policy-engine";
import { signatureOf, type Context, type Decision, type Policy, type RunState, type RunStateStore } from "@curb/shared";
import { NULL_SINK, type AuditSink } from "./audit.js";
import { ALLOW_ANONYMOUS, type Authenticator, type GatewayIdentity } from "./auth.js";
import { errorBody, statusForDecision } from "./errors.js";
import { PriceTable } from "./pricing.js";
import {
  StreamUsageAccumulator,
  detectProvider,
  estimateUsage,
  extractUsage,
  isStreaming,
  messagesOf,
  sanitizeHeaders,
  upstreamFor,
  type Provider,
  type Usage,
} from "./providers.js";

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
    method?: string,
  ) => Promise<UpstreamResponse>;
  audit?: AuditSink;
  prices?: PriceTable;
  failMode?: "open" | "closed";
  /** How long a THROTTLE may block before we reject the request instead. */
  maxThrottleMs?: number;
  /**
   * Who is allowed through. Defaults to anonymous, which is only correct for tests and
   * local dev — `index.ts` refuses to boot that way unless explicitly told to.
   */
  authenticate?: Authenticator;
  /** Max request body. LLM requests carry whole conversations; Fastify's 1 MB default rejects them. */
  bodyLimit?: number;
  now?: () => number;
  logger?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    curb?: GatewayIdentity;
  }
}

export function buildApp(deps: GatewayDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: deps.bodyLimit ?? 32 * 1024 * 1024,
  });
  const audit = deps.audit ?? NULL_SINK;
  const prices = deps.prices ?? new PriceTable();
  const failMode = deps.failMode ?? "closed";
  const now = deps.now ?? Date.now;
  const maxThrottleMs = deps.maxThrottleMs ?? 5_000;
  const authenticate = deps.authenticate ?? ALLOW_ANONYMOUS;

  app.get("/health", async () => ({ ok: true, service: "curb-gateway" }));

  app.addHook("preHandler", async (req, reply) => {
    if (req.url === "/health") return;
    const identity = authenticate(req.headers["x-curb-key"]);
    if (!identity) {
      return reply
        .code(401)
        .send({ error: { message: "missing or invalid x-curb-key", type: "curb_unauthorized" } });
    }
    req.curb = identity;
  });

  /** Reads that carry no body (e.g. GET /v1/models) are forwarded, not policed. */
  app.get("/v1/*", async (req, reply) => {
    const provider = detectProvider(req.url, req.headers as Record<string, unknown>);
    const res = await deps.forward(
      `${upstreamFor(provider)}${req.url}`,
      sanitizeHeaders(req.headers as Record<string, unknown>),
      undefined,
      false,
      "GET",
    );
    copyHeaders(res, reply);
    return reply.code(res.status).send(res.json);
  });

  app.post("/v1/*", async (req, reply) => {
    const headers = req.headers as Record<string, unknown>;
    const runId = (headers["x-curb-run-id"] as string) || randomUUID();
    // The project comes from the authenticated key — NEVER from a caller-supplied header.
    const projectId = req.curb?.projectId;
    const stateKey = runKey(projectId, runId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const provider = detectProvider(req.url, headers);
    const streaming = isStreaming(body);
    const t = now();

    const stored = await deps.store.get(stateKey);
    const signature = signatureOf(messagesOf(body));
    // why: evaluate against what the windows WOULD be, and only persist if the call is
    // allowed. A blocked call must not fill the loop window with its own signature —
    // that used to make the breaker trip on calls that never happened.
    const state: RunState = {
      ...stored,
      sigWindow: [...stored.sigWindow, signature].slice(-20),
      callTimestamps: [...stored.callTimestamps, t].slice(-200),
    };

    const buckets = costWindowKeys(projectId, t);
    const [hourSpend, daySpend] = await Promise.all([
      deps.store.getCost(buckets.hour.bucket),
      deps.store.getCost(buckets.day.bucket),
    ]);

    const ctx: Context = {
      kind: "llm_call",
      runId,
      projectId,
      model: body.model as string | undefined,
      env: process.env.NODE_ENV,
      signature,
      // Priced before forwarding, so a cost cap can hold the call instead of learning
      // about the overshoot from the response.
      estimatedCostUsd: prices.costUsd(body.model as string | undefined, estimateUsage(body)),
      costWindows: { hour: hourSpend, day: daySpend },
      now: t,
    };

    const decision = await decide(ctx, state, deps, failMode, req.log);
    const policyType = decision.policyId
      ? (await safePolicies(deps)).find((p) => p.id === decision.policyId)?.type
      : undefined;

    reply.header("x-curb-run-id", runId);
    reply.header("x-curb-cost-usd", state.costUsd.toFixed(6));

    if (decision.effect === "DENY" || decision.effect === "ASK") {
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

    // Allowed: only now does this call join the loop / rate windows.
    await Promise.all([
      deps.store.pushWindow(stateKey, "sigWindow", signature, 20),
      deps.store.pushWindow(stateKey, "callTimestamps", t, 200),
    ]);

    const upstreamHeaders = sanitizeHeaders(headers);
    const target = `${upstreamFor(provider)}${req.url}`;
    const res = await deps.forward(target, upstreamHeaders, body, streaming, "POST");

    copyHeaders(res, reply);

    if (streaming && res.stream) {
      emit(audit, ctx, { effect: "ALLOW" }, state, t);
      return reply.code(res.status).send(
        meterStream(res.stream, async (usage) => {
          await settle(deps, stateKey, buckets, body.model as string | undefined, usage, prices);
        }),
      );
    }

    const usage = extractUsage(res.json);
    const after = await settle(deps, stateKey, buckets, body.model as string | undefined, usage, prices);
    reply.header("x-curb-cost-usd", after.costUsd.toFixed(6));
    reply.header("x-curb-tokens", String(after.tokens));
    emit(audit, ctx, { effect: "ALLOW" }, after, t);
    return reply.code(res.status).send(res.json);
  });

  return app;
}

function copyHeaders(res: UpstreamResponse, reply: { header: (k: string, v: string | string[]) => unknown }) {
  for (const [k, v] of Object.entries(res.headers)) {
    if (k.toLowerCase() === "content-length" || v === undefined) continue;
    reply.header(k, v);
  }
}

async function decide(
  ctx: Context,
  state: RunState,
  deps: GatewayDeps,
  failMode: "open" | "closed",
  log: FastifyRequest["log"],
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

/** Apply usage to the run state, and to the wider cost windows, after a call. */
async function settle(
  deps: GatewayDeps,
  stateKey: string,
  buckets: ReturnType<typeof costWindowKeys>,
  model: string | undefined,
  usage: Usage,
  prices: PriceTable,
) {
  const costUsd = prices.costUsd(model, usage);
  const [state] = await Promise.all([
    deps.store.bump(stateKey, { tokens: usage.totalTokens, costUsd, steps: 1 }),
    costUsd > 0 ? deps.store.bumpCost(buckets.hour, costUsd) : Promise.resolve(0),
    costUsd > 0 ? deps.store.bumpCost(buckets.day, costUsd) : Promise.resolve(0),
  ]);
  return state;
}

/**
 * Pass the stream through untouched while metering usage from the SSE events.
 *
 * why the `once` guard: usage must be settled even when the client hangs up or the
 * upstream dies mid-stream. Without it, an agent that always disconnects early would
 * never advance its own cost counter — an easy way to make a cost cap meaningless.
 */
function meterStream(source: NodeJS.ReadableStream, onDone: (u: Usage) => Promise<void>) {
  const acc = new StreamUsageAccumulator();
  const out = new PassThrough();
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    void onDone(acc.result());
  };

  source.on("data", (chunk: Buffer) => {
    acc.push(chunk.toString("utf8"));
    out.write(chunk);
  });
  source.on("end", () => {
    out.end();
    finish();
  });
  source.on("close", finish);
  source.on("error", (err) => {
    finish();
    out.destroy(err as Error);
  });
  // The client went away: stop pulling from upstream, but keep what we metered.
  out.on("close", () => {
    finish();
    (source as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  });
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
