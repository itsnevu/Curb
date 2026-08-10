import Fastify from "fastify";
import { evaluate, InMemoryRunStateStore } from "@curb/policy-engine";
import { PolicySchema, type Context, type Policy } from "@curb/shared";

// TODO(M2): ganti in-memory dengan Postgres (policies, events, approvals, runs).
const policies = new Map<string, Policy>();
const approvals = new Map<string, { id: string; runId: string; tool: string; status: "pending" | "approved" | "denied" }>();
const store = new InMemoryRunStateStore(() => Date.now());

const app = Fastify({ logger: true });

// Decision API — dipanggil SDK untuk tool_call / step.
app.post("/v1/decisions", async (req) => {
  const ctx = req.body as Context;
  const state = await store.get(ctx.runId);
  if (ctx.kind === "tool_call" && ctx.toolName) {
    state.toolWindow = [...state.toolWindow, ctx.toolName].slice(-12);
  }
  if (ctx.kind === "step") state.stepCount += 1;
  await store.save(state);
  const decision = evaluate(ctx, [...policies.values()], state);

  // Kalau ASK, buat approval pending.
  if (decision.effect === "ASK") {
    const id = "apr_" + Math.random().toString(36).slice(2, 10);
    approvals.set(id, { id, runId: ctx.runId, tool: ctx.toolName ?? "?", status: "pending" });
    return { ...decision, approvalId: id };
  }
  return decision;
});

// CRUD policy
app.get("/v1/policies", async () => [...policies.values()]);
app.post("/v1/policies", async (req, reply) => {
  const parsed = PolicySchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.format());
  policies.set(parsed.data.id, parsed.data);
  return parsed.data;
});
app.delete("/v1/policies/:id", async (req: any) => { policies.delete(req.params.id); return { ok: true }; });

// Approval flow (human-in-the-loop)
app.get("/v1/approvals", async () => [...approvals.values()]);
app.get("/v1/approvals/:id", async (req: any) => approvals.get(req.params.id) ?? { status: "unknown" });
app.post("/v1/approvals/:id/decide", async (req: any) => {
  const a = approvals.get(req.params.id);
  if (!a) return { ok: false };
  a.status = req.body?.approve ? "approved" : "denied";
  return a;
});

app.get("/health", async () => ({ ok: true }));

const port = Number(process.env.CONTROL_PLANE_PORT ?? 8090);
app.listen({ port, host: "0.0.0.0" }).then(() => app.log.info(`curb control-plane :${port}`));
