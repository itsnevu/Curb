import { InMemoryRunStateStore } from "../packages/policy-engine/src/index.js";
import { Curb, PolicyViolation } from "../packages/sdk-ts/src/index.js";
import { buildApp as buildControlPlane } from "../apps/control-plane/src/app.js";
import { hashApiKey } from "../apps/control-plane/src/auth.js";
import { MemoryRepo } from "../apps/control-plane/src/repo/memory.js";
import { buildApp as buildGateway } from "../apps/gateway/src/app.js";
import { HttpAuditSink } from "../apps/gateway/src/audit.js";
import { forwardUpstream } from "../apps/gateway/src/intercept.js";
import { PolicySource } from "../apps/gateway/src/policy-source.js";
import { startFakeProvider } from "./fake-provider.js";

/**
 * 60-second demo: a single process runs the control plane, the gateway, a fake provider,
 * and three agents that each trigger one kind of protection.
 */
const KEY = "demo-key";
const c = {
  judul: (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`),
  ok: (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`),
  blok: (s: string) => console.log(`  \x1b[31m⛔\x1b[0m ${s}`),
  tanya: (s: string) => console.log(`  \x1b[33m✋\x1b[0m ${s}`),
  info: (s: string) => console.log(`  \x1b[2m${s}\x1b[0m`),
};

async function main() {
  const provider = await startFakeProvider();
  process.env.OPENAI_UPSTREAM = provider.url;

  const repo = new MemoryRepo();
  await repo.upsertProject({ id: "demo", orgId: "demo", name: "demo", apiKeyHash: hashApiKey(KEY) });
  const store = new InMemoryRunStateStore(() => Date.now());

  const cp = buildControlPlane({ repo, store });
  await cp.listen({ port: Number(process.env.CONTROL_PLANE_PORT ?? 8090), host: "127.0.0.1" });
  const cpUrl = addrOf(cp.server.address());

  const audit = new HttpAuditSink(cpUrl, { apiKey: KEY, flushMs: 50 });
  const gw = buildGateway({
    store,
    loadPolicies: () => new PolicySource({ controlPlaneUrl: cpUrl, apiKey: KEY, ttlMs: 200 }).load(),
    forward: forwardUpstream,
    audit: audit,
  });
  await gw.listen({ port: Number(process.env.GATEWAY_PORT ?? 8080), host: "127.0.0.1" });
  const gwUrl = addrOf(gw.server.address());

  console.log(`\n\x1b[1mCurb\x1b[0m — dashboard: \x1b[4m${cpUrl}\x1b[0m   gateway: ${gwUrl}   (api key: ${KEY})`);

  // Scoped per run so each scenario demonstrates exactly one thing.
  await policy({
    name: "cost cap $0.03/run", type: "cost_cap", action: "deny",
    scope: { run: "demo-cost" }, params: { maxUsd: 0.03, preflight: false },
  });
  await policy({
    name: "cost cap $0.005 with preflight", type: "cost_cap", action: "deny",
    scope: { run: "demo-preflight" }, params: { maxUsd: 0.005 },
  });
  await policy({ name: "loop detect", type: "loop_detect", action: "deny", params: { maxRepeats: 3 } });
  await policy({
    name: "delete_file requires approval", type: "tool_permission", action: "ask",
    params: { tools: ["delete_file"], mode: "ask" },
  });

  async function policy(p: Record<string, unknown>) {
    const res = await fetch(`${cpUrl}/v1/policies`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-curb-key": KEY },
      body: JSON.stringify({ scope: {}, enabled: true, ...p }),
    });
    if (!res.ok) throw new Error(`failed to create policy: ${await res.text()}`);
  }

  const llm = async (runId: string, isi: string, over: Record<string, unknown> = {}) => {
    const res = await fetch(`${gwUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-curb-run-id": runId, authorization: "Bearer sk-palsu" },
      body: JSON.stringify({ model: "gpt-4o", max_tokens: 1000, messages: [{ role: "user", content: isi }], ...over }),
    });
    return { status: res.status, cost: res.headers.get("x-curb-cost-usd"), body: await res.json() as any };
  };

  // ── A. Cost cap ────────────────────────────────────────────────────────
  c.judul("A. Cost blowup — agent halted after passing $0.03");
  for (let i = 1; i <= 5; i++) {
    const r = await llm("demo-cost", `analisis bagian ${i}`);
    if (r.status === 200) c.ok(`call ${i} passed — cumulative cost $${r.cost}`);
    else {
      c.blok(`call ${i} BLOCKED — ${r.body.error.message}`);
      break;
    }
  }

  // ── B. Loop breaker ────────────────────────────────────────────────────
  c.judul("B. Infinite loop — identical repeated messages detected");
  for (let i = 1; i <= 5; i++) {
    const r = await llm("demo-loop", "the exact same question");
    if (r.status === 200) c.ok(`call ${i} passed (identical message)`);
    else {
      c.blok(`call ${i} BLOCKED — ${r.body.error.message}`);
      break;
    }
  }

  // ── B2. Preflight ──────────────────────────────────────────────────────
  c.judul("B2. One call too expensive to risk — refused before any money is spent");
  {
    const r = await llm("demo-preflight", "write me a novel", { max_tokens: 100_000 });
    if (r.status === 200) c.ok("call passed (unexpected)");
    else {
      c.blok(`call 1 BLOCKED — ${r.body.error.message}`);
      c.info("the request never reached the provider, so nothing was billed");
    }
  }

  // ── C. Ask-before-acting ───────────────────────────────────────────────
  c.judul("C. Dangerous action — held until a human decides");
  const curb = new Curb({ baseUrl: cpUrl, apiKey: KEY, approvalTimeoutMs: 15_000 });
  const terhapus: string[] = [];
  const deleteFile = curb.wrapTool(
    async (path: string) => {
      terhapus.push(path);
      return `deleted: ${path}`;
    },
    { name: "delete_file", sensitivity: "high" },
  );

  const agent = curb.run(async () => deleteFile("/data/production.db"), "demo-approval");
  await tunggu(() => antrian(cpUrl).then((q) => q.length > 0));
  const [menunggu] = await antrian(cpUrl);
  c.tanya(`agent requests permission to run '${menunggu.toolName}' — execution HELD`);
  c.info(`nothing touched yet: ${JSON.stringify(terhapus)}`);
  c.info(`(in the real world an operator clicks Approve/Deny at ${cpUrl})`);

  await new Promise((r) => setTimeout(r, 800));
  await fetch(`${cpUrl}/v1/approvals/${menunggu.id}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-curb-key": KEY },
    body: JSON.stringify({ approve: true, by: "operator-demo" }),
  });
  c.ok(`approved by operator → ${await agent}`);

  // ── C2. Penolakan ──────────────────────────────────────────────────────
  const ditolak = curb.run(async () => deleteFile("/data/even-more-important.db"), "demo-deny").catch((e) => e);
  await tunggu(() => antrian(cpUrl).then((q) => q.length > 0));
  const [kedua] = await antrian(cpUrl);
  await fetch(`${cpUrl}/v1/approvals/${kedua.id}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-curb-key": KEY },
    body: JSON.stringify({ approve: false, by: "operator-demo" }),
  });
  const err = await ditolak;
  c.blok(`denied by operator → ${err instanceof PolicyViolation ? err.message : err}`);
  c.info(`actually deleted: ${JSON.stringify(terhapus)}`);

  await audit.flush(); // make sure gateway events have landed before reading stats

  // ── Ringkasan ──────────────────────────────────────────────────────────
  const stats = await (await fetch(`${cpUrl}/v1/stats`, { headers: { "x-curb-key": KEY } })).json() as any;
  c.judul("Recorded in the control plane");
  console.log(
    `  runs: ${stats.runs} · blocked: ${stats.blocked} · DENY decisions: ${stats.denied} · ` +
      `approvals asked: ${stats.asked} · total cost: $${stats.totalCostUsd.toFixed(4)}`,
  );
  console.log(`\n  Live dashboard: \x1b[4m${cpUrl}\x1b[0m  (Ctrl+C to stop)\n`);

  if (process.env.CURB_DEMO_EXIT === "1") {
    await Promise.all([gw.close(), cp.close(), provider.close()]);
  }
}

const antrian = async (cpUrl: string) =>
  (await (await fetch(`${cpUrl}/v1/approvals?status=pending`, { headers: { "x-curb-key": KEY } })).json()) as Array<{
    id: string;
    toolName: string;
  }>;

async function tunggu(cond: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for condition");
}

function addrOf(addr: ReturnType<import("node:net").Server["address"]>) {
  return `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}

main().catch((err) => {
  console.error("\ndemo failed:", err);
  process.exit(1);
});
