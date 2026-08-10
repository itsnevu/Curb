/**
 * Runs the SDK exactly the way examples/ wires it, against the fake provider.
 * Proves the wiring (guarded tool + gateway headers), not the model.
 */
import { InMemoryRunStateStore } from "../packages/policy-engine/src/index.js";
import { Curb, PolicyViolation } from "../packages/sdk-ts/src/index.js";
import { buildApp as buildCP } from "../apps/control-plane/src/app.js";
import { hashApiKey } from "../apps/control-plane/src/auth.js";
import { MemoryRepo } from "../apps/control-plane/src/repo/memory.js";
import { buildApp as buildGW } from "../apps/gateway/src/app.js";
import { keyAuthenticator } from "../apps/gateway/src/auth.js";
import { forwardUpstream } from "../apps/gateway/src/intercept.js";
import { startFakeProvider } from "./fake-provider.js";

async function main() {
  const KEY = "ex-key";
  const provider = await startFakeProvider();
  process.env.OPENAI_UPSTREAM = provider.url;

  const repo = new MemoryRepo();
  await repo.upsertProject({ id: "demo", orgId: "demo", name: "demo", apiKeyHash: hashApiKey(KEY) });
  const store = new InMemoryRunStateStore(() => Date.now());

  const cp = buildCP({ repo, store });
  await cp.listen({ port: 0, host: "127.0.0.1" });
  const cpUrl = `http://127.0.0.1:${(cp.server.address() as any).port}`;

  const gw = buildGW({
    store, loadPolicies: async () => [], forward: forwardUpstream,
    authenticate: keyAuthenticator([{ key: KEY, projectId: "demo" }]),
  });
  await gw.listen({ port: 0, host: "127.0.0.1" });
  const gwUrl = `http://127.0.0.1:${(gw.server.address() as any).port}`;

  await fetch(`${cpUrl}/v1/policies`, {
    method: "POST", headers: { "content-type": "application/json", "x-curb-key": KEY },
    body: JSON.stringify({ name: "ask", type: "tool_permission", action: "ask", scope: {}, enabled: true,
                           params: { tools: ["delete_file"], mode: "ask" } }),
  });

  const curb = new Curb({ baseUrl: cpUrl, apiKey: KEY, approvalTimeoutMs: 5000 });
  const removed: string[] = [];
  const deleteFile = curb.wrapTool(async (p: string) => { removed.push(p); return `deleted ${p}`; },
    { name: "delete_file", sensitivity: "high" });

  await curb.run(async () => {
    // 1) the pattern every example uses for cost/loop coverage
    const headers = curb.gatewayHeaders();
    console.log("gatewayHeaders ->", JSON.stringify(headers));
    const res = await fetch(`${gwUrl}/v1/chat/completions`, {
      method: "POST",
      // gatewayHeaders() already carries the key and run id — adding it again would
      // send a duplicate header, which Node joins into "k, k" and the gateway rejects.
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "gpt-4o", max_tokens: 50, messages: [{ role: "user", content: "hi" }] }),
    });
    console.log("LLM call via gateway ->", res.status, "cost:", res.headers.get("x-curb-cost-usd"));
    if (res.status !== 200) throw new Error("gateway call failed");

    // 2) the guarded-tool pattern: must be HELD, then released by an operator
    const pending = deleteFile("/tmp/x");
    await new Promise((r) => setTimeout(r, 100));
    if (removed.length !== 0) throw new Error("tool ran before approval!");
    const queue = await (await fetch(`${cpUrl}/v1/approvals?status=pending`, { headers: { "x-curb-key": KEY } })).json() as any[];
    console.log("held in approval queue ->", queue[0].toolName);
    await fetch(`${cpUrl}/v1/approvals/${queue[0].id}/decide`, {
      method: "POST", headers: { "content-type": "application/json", "x-curb-key": KEY },
      body: JSON.stringify({ approve: true, by: "example-check" }),
    });
    console.log("after approval ->", await pending);
  }, "example-run");

  if (removed.length !== 1) throw new Error("tool did not run after approval");
  console.log("\n✅ example wiring verified: gateway headers, metered LLM call, held tool, approval release");
  await Promise.all([gw.close(), cp.close(), provider.close()]);
}

main().catch((err) => {
  console.error('example verification failed:', err);
  process.exit(1);
});
