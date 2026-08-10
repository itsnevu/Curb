import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryRunStateStore } from "@curb/policy-engine";
import { buildApp } from "./app.js";
import { hashApiKey } from "./auth.js";
import { MemoryRepo } from "./repo/memory.js";

const KEY = "test-key";
const H = { "x-curb-key": KEY, "content-type": "application/json" };

let app: FastifyInstance;
let repo: MemoryRepo;

beforeEach(async () => {
  repo = new MemoryRepo();
  await repo.upsertProject({ id: "proj1", orgId: "org1", name: "test", apiKeyHash: hashApiKey(KEY) });
  app = buildApp({ repo, store: new InMemoryRunStateStore(() => 1_000), now: () => 1_000 });
});

const post = (url: string, payload: unknown, headers: Record<string, string> = H) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });
const get = (url: string, headers: Record<string, string> = H) => app.inject({ method: "GET", url, headers });

const policy = (over: Record<string, unknown> = {}) => ({
  name: "test", type: "cost_cap", action: "deny", params: { maxUsd: 2 }, scope: {}, enabled: true, ...over,
});

describe("auth", () => {
  it("rejects a request with no API key", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/policies" })).statusCode).toBe(401);
  });
  it("rejects a wrong API key", async () => {
    expect((await get("/v1/policies", { "x-curb-key": "wrong" })).statusCode).toBe(401);
  });
  it("accepts a Bearer token", async () => {
    expect((await get("/v1/policies", { authorization: `Bearer ${KEY}` })).statusCode).toBe(200);
  });
  it("health is open without auth", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
  it("the API key is never stored in plain text", async () => {
    const p = await repo.projectByApiKeyHash(hashApiKey(KEY));
    expect(p!.apiKeyHash).not.toContain(KEY);
    expect(p!.apiKeyHash).toHaveLength(64);
  });
});

describe("policy CRUD", () => {
  it("creates a policy that is immediately readable", async () => {
    const created = await post("/v1/policies", policy());
    expect(created.statusCode).toBe(201);
    expect((created.json() as { id: string }).id).toMatch(/^pol_/);
    expect((await get("/v1/policies")).json()).toHaveLength(1);
  });
  it("rejects an invalid policy with 400", async () => {
    const res = await post("/v1/policies", policy({ type: "bogus-type" }));
    expect(res.statusCode).toBe(400);
  });
  it("update toggles enabled", async () => {
    const id = (await post("/v1/policies", policy())).json().id;
    await app.inject({ method: "PUT", url: `/v1/policies/${id}`, headers: H, payload: { enabled: false } });
    expect((await get(`/v1/policies/${id}`)).json().enabled).toBe(false);
  });
  it("deletes a policy", async () => {
    const id = (await post("/v1/policies", policy())).json().id;
    await app.inject({ method: "DELETE", url: `/v1/policies/${id}`, headers: H });
    expect((await get("/v1/policies")).json()).toHaveLength(0);
  });
  describe("params are validated at write time", () => {
    // why: a policy with wrong params is worse than no policy — it looks like
    // protection and protects nothing. Better to fail on write than at 3am.
    const bad: Array<[string, string, unknown]> = [
      ["a typo in the param name", "cost_cap", { maxUSD: 2 }],
      ["a negative cap", "cost_cap", { maxUsd: -5 }],
      ["a numeric cap sent as a string", "cost_cap", { maxUsd: "2" }],
      ["an unknown window", "cost_cap", { maxUsd: 2, window: "week" }],
      ["a tool_permission that would match nothing", "tool_permission", {}],
      ["maxRepeats below 2 (every call repeats itself once)", "loop_detect", { maxRepeats: 1 }],
    ];
    for (const [label, type, params] of bad) {
      it(`rejects ${label}`, async () => {
        const res = await post("/v1/policies", policy({ type, params }));
        expect(res.statusCode).toBe(400);
      });
    }

    it("fills in documented defaults so the engine never has to guess", async () => {
      const created = (await post("/v1/policies", policy({ type: "cost_cap", params: { maxUsd: 2 } }))).json();
      expect(created.params).toMatchObject({ maxUsd: 2, window: "run", preflight: true });
    });
  });

  it("404 for a policy that does not exist", async () => {
    expect((await get("/v1/policies/does-not-exist")).statusCode).toBe(404);
  });
});

describe("Decision API (M2 acceptance: a policy created via API is enforced)", () => {
  it("tool_permission in deny mode → DENY", async () => {
    await post("/v1/policies", policy({
      type: "tool_permission", action: "deny", params: { tools: ["wipe_db"], mode: "deny" },
    }));
    const d = await post("/v1/decisions", { kind: "tool_call", runId: "r1", toolName: "wipe_db" });
    expect(d.json()).toMatchObject({ effect: "DENY" });
  });

  it("an unregulated tool still gets ALLOW", async () => {
    await post("/v1/policies", policy({
      type: "tool_permission", action: "deny", params: { tools: ["wipe_db"], mode: "deny" },
    }));
    const d = await post("/v1/decisions", { kind: "tool_call", runId: "r1", toolName: "read_file" });
    expect(d.json().effect).toBe("ALLOW");
  });

  it("step_limit counts steps across calls", async () => {
    await post("/v1/policies", policy({ type: "step_limit", params: { maxSteps: 3 } }));
    const effects = [];
    for (let i = 0; i < 5; i++) {
      effects.push((await post("/v1/decisions", { kind: "step", runId: "r1" })).json().effect);
    }
    expect(effects).toEqual(["ALLOW", "ALLOW", "ALLOW", "DENY", "DENY"]);
  });

  it("an invalid body → 400", async () => {
    expect((await post("/v1/decisions", { kind: "ngaco", runId: "r1" })).statusCode).toBe(400);
  });

  it("every decision is recorded as an event", async () => {
    await post("/v1/decisions", { kind: "tool_call", runId: "r1", toolName: "baca" });
    const events = (await get("/v1/events")).json();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ runId: "r1", effect: "ALLOW", kind: "tool_call" });
  });

  it("a run summary is formed from decisions", async () => {
    await post("/v1/decisions", { kind: "step", runId: "r1" });
    const runs = (await get("/v1/runs")).json();
    expect(runs[0]).toMatchObject({ id: "r1", projectId: "proj1" });
  });
});

describe("approval flow end-to-end (M2 acceptance)", () => {
  beforeEach(async () => {
    await post("/v1/policies", policy({
      name: "delete_file requires approval", type: "tool_permission", action: "ask",
      params: { tools: ["delete_file"], mode: "ask" },
    }));
  });

  const ask = () =>
    post("/v1/decisions", { kind: "tool_call", runId: "r1", toolName: "delete_file", toolArgs: { path: "/tmp/a" } });

  it("ASK creates a pending approval that shows up in the queue", async () => {
    const d = (await ask()).json();
    expect(d.effect).toBe("ASK");
    expect(d.approvalId).toMatch(/^apr_/);
    const queue = (await get("/v1/approvals?status=pending")).json();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ toolName: "delete_file", status: "pending" });
  });

  it("approving releases the caller that is long-polling", async () => {
    const { approvalId } = (await ask()).json();
    // the SDK hangs waiting for a decision...
    const waiting = get(`/v1/approvals/${approvalId}?wait=5000`);
    await new Promise((r) => setTimeout(r, 20));
    // ...the dashboard presses Approve
    await post(`/v1/approvals/${approvalId}/decide`, { approve: true, by: "alice" });
    const resolved = (await waiting).json();
    expect(resolved).toMatchObject({ status: "approved", decidedBy: "alice" });
  });

  it("denying also releases the waiter", async () => {
    const { approvalId } = (await ask()).json();
    const waiting = get(`/v1/approvals/${approvalId}?wait=5000`);
    await new Promise((r) => setTimeout(r, 20));
    await post(`/v1/approvals/${approvalId}/decide`, { approve: false });
    expect((await waiting).json().status).toBe("denied");
  });

  it("a timed-out long-poll returns pending status, not an error", async () => {
    const { approvalId } = (await ask()).json();
    const res = await get(`/v1/approvals/${approvalId}?wait=30`);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("pending");
  });

  it("the first decision wins; a second click is refused with 409", async () => {
    const { approvalId } = (await ask()).json();
    const first = await post(`/v1/approvals/${approvalId}/decide`, { approve: true, by: "alice" });
    expect(first.statusCode).toBe(200);

    const second = await post(`/v1/approvals/${approvalId}/decide`, { approve: false, by: "bob" });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      error: { type: "curb_already_decided" },
      approval: { status: "approved", decidedBy: "alice" },
    });

    // and the stored decision is untouched
    const stored = (await get(`/v1/approvals/${approvalId}`)).json();
    expect(stored).toMatchObject({ status: "approved", decidedBy: "alice" });
  });

  it("tool arguments are stored redacted; secrets do not leak", async () => {
    await post("/v1/decisions", {
      kind: "tool_call", runId: "r2", toolName: "delete_file",
      toolArgs: { path: "/etc/passwd", api_key: "sk-super-secret" },
    });
    const queue = (await get("/v1/approvals")).json();
    const args = JSON.stringify(queue[0].args);
    expect(args).toContain("/etc/passwd"); // the human still gets enough context
    expect(args).not.toContain("sk-super-secret");
    expect(args).toContain("sha256:");
  });

  it("another project's approval is not visible", async () => {
    const { approvalId } = (await ask()).json();
    await repo.upsertProject({ id: "proj2", orgId: "org1", name: "other", apiKeyHash: hashApiKey("other-key") });
    const res = await get(`/v1/approvals/${approvalId}`, { "x-curb-key": "other-key" });
    expect(res.statusCode).toBe(404);
  });
});

describe("audit ingest from the gateway", () => {
  it("accepts a batch and summarises it into a run", async () => {
    const res = await post("/v1/events", {
      events: [
        { runId: "rg", ts: 1000, kind: "llm_call", effect: "ALLOW", costUsdSnapshot: 0.5, tokensSnapshot: 100 },
        { runId: "rg", ts: 2000, kind: "llm_call", effect: "DENY", policyId: "cc", reason: "cost cap", costUsdSnapshot: 2.1, tokensSnapshot: 400 },
      ],
    });
    expect(res.json()).toMatchObject({ ok: true, accepted: 2 });
    const run = (await get("/v1/runs")).json()[0];
    expect(run).toMatchObject({ id: "rg", status: "blocked", verdict: "cc" });
    expect(run.totalCostUsd).toBeCloseTo(2.1, 6);
  });

  it("stats summarise everything for the dashboard", async () => {
    await post("/v1/events", {
      events: [{ runId: "rg", ts: 1000, kind: "llm_call", effect: "DENY", policyId: "cc", costUsdSnapshot: 3 }],
    });
    const s = (await get("/v1/stats")).json();
    expect(s).toMatchObject({ runs: 1, blocked: 1, denied: 1 });
    expect(s.totalCostUsd).toBeCloseTo(3, 6);
  });

  it("an invalid batch is rejected with 400", async () => {
    expect((await post("/v1/events", { events: [{ runId: "x" }] })).statusCode).toBe(400);
  });
});

describe("dashboard", () => {
  it("is served at the root without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Approval queue");
  });

  it("NEVER embeds an API key in the served page", async () => {
    // why: `GET /` is unauthenticated by design, so a key baked into the HTML would
    // hand full API access to anyone who can reach the dashboard.
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.body).not.toContain(KEY);
    expect(res.body).not.toContain("__CURB_API_KEY__");
  });

  it("asks the browser to sign in and keeps the key in the tab only", async () => {
    const body = (await app.inject({ method: "GET", url: "/" })).body;
    expect(body).toContain("sessionStorage");
    expect(body).toContain("loginForm");
  });
});

describe("fail mode", () => {
  it("fail-closed denies when the policy repo errors", async () => {
    const broken = new MemoryRepo();
    await broken.upsertProject({ id: "p", orgId: "o", name: "n", apiKeyHash: hashApiKey(KEY) });
    broken.listPolicies = async () => {
      throw new Error("db is down");
    };
    const a = buildApp({ repo: broken, store: new InMemoryRunStateStore(() => 0), now: () => 0 });
    const res = await a.inject({ method: "POST", url: "/v1/decisions", headers: H, payload: { kind: "step", runId: "r" } });
    expect(res.json()).toMatchObject({ effect: "DENY", policyId: "curb_fail_closed" });
  });

  it("fail-open still lets it through", async () => {
    const broken = new MemoryRepo();
    await broken.upsertProject({ id: "p", orgId: "o", name: "n", apiKeyHash: hashApiKey(KEY) });
    broken.listPolicies = async () => {
      throw new Error("db is down");
    };
    const a = buildApp({ repo: broken, store: new InMemoryRunStateStore(() => 0), now: () => 0, failMode: "open" });
    const res = await a.inject({ method: "POST", url: "/v1/decisions", headers: H, payload: { kind: "step", runId: "r" } });
    expect(res.json().effect).toBe("ALLOW");
  });
});
