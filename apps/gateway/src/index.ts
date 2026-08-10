import Fastify from "fastify";
import { evaluate, InMemoryRunStateStore } from "@curb/policy-engine";
import type { Context, Policy } from "@curb/shared";
import { forwardUpstream, extractUsage, estimateCostUsd } from "./intercept.js";
import { signatureOf } from "./signature.js";

// TODO(M2): ambil policy dari control-plane; sementara hardcode contoh.
const POLICIES: Policy[] = [
  { id: "c1", name: "cost cap $2/run", type: "cost_cap", scope: {}, params: { maxUsd: 2 }, action: "deny", enabled: true },
  { id: "l1", name: "loop detect", type: "loop_detect", scope: {}, params: { maxRepeats: 3 }, action: "deny", enabled: true },
];

const store = new InMemoryRunStateStore(() => Date.now()); // TODO(M1): RedisRunStateStore
const app = Fastify({ logger: true });
const FAIL_MODE = process.env.CURB_FAIL_MODE ?? "closed";

// Proxy OpenAI-compatible. User arahkan base_url ke http://host:8080/v1
app.post("/v1/*", async (req, reply) => {
  const runId = (req.headers["x-curb-run-id"] as string) ?? cryptoRandom();
  const body = req.body as any;

  const state = await store.get(runId);
  // update window untuk loop detect SEBELUM evaluate
  state.sigWindow = [...state.sigWindow, signatureOf(body?.messages)].slice(-10);
  state.callTimestamps = [...state.callTimestamps, Date.now()].slice(-100);

  const ctx: Context = {
    kind: "llm_call",
    runId,
    model: body?.model,
    messages: body?.messages,
    env: process.env.NODE_ENV,
    meta: { now: Date.now() },
  };

  let decision;
  try {
    decision = evaluate(ctx, POLICIES, state);
  } catch (err) {
    req.log.error({ err }, "engine error");
    decision = FAIL_MODE === "open" ? { effect: "ALLOW" as const } : { effect: "DENY" as const, reason: "engine down (fail-closed)" };
  }

  if (decision.effect === "DENY") {
    await store.save(state);
    return reply.code(429).send({ error: { type: "curb_policy", code: decision.policyId, message: decision.reason } });
  }
  if (decision.effect === "THROTTLE" && decision.retryAfterMs) {
    reply.header("retry-after", Math.ceil(decision.retryAfterMs / 1000));
  }

  // forward ke provider asli
  const upstream = await forwardUpstream(req.url, req.headers, body);
  const usage = extractUsage(upstream.json);
  state.tokens += usage.totalTokens;
  state.costUsd += estimateCostUsd(body?.model, usage);
  state.stepCount += 1;
  await store.save(state);

  reply.header("x-curb-run-id", runId);
  reply.header("x-curb-cost-usd", state.costUsd.toFixed(6));
  return reply.code(upstream.status).send(upstream.json);
});

app.get("/health", async () => ({ ok: true }));

const port = Number(process.env.GATEWAY_PORT ?? 8080);
app.listen({ port, host: "0.0.0.0" }).then(() => app.log.info(`curb gateway :${port}`));

function cryptoRandom() {
  return "run_" + Math.abs(hashStr(String(process.hrtime.bigint()))).toString(36);
}
function hashStr(s: string) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }
