import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryRunStateStore } from "@curb/policy-engine";
import { buildApp } from "./app.js";
import { hashApiKey } from "./auth.js";
import { expireApprovals } from "./expiry.js";
import { MemoryRepo } from "./repo/memory.js";
import { ApprovalHub } from "./approval-hub.js";

const KEY = "test-key";
const H: Record<string, string> = { "x-curb-key": KEY, "content-type": "application/json" };

let repo: MemoryRepo;
let clock = 1_000;

async function makeApp(over: Partial<Parameters<typeof buildApp>[0]> = {}): Promise<FastifyInstance> {
  repo = new MemoryRepo();
  await repo.upsertProject({ id: "proj1", orgId: "org1", name: "test", apiKeyHash: hashApiKey(KEY) });
  return buildApp({ repo, store: new InMemoryRunStateStore(() => clock), now: () => clock, ...over });
}

beforeEach(() => {
  clock = 1_000;
});

describe("rate limiting", () => {
  it("lets a project through up to its per-minute budget, then 429s", async () => {
    const app = await makeApp({ rateLimitPerMinute: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await app.inject({ method: "GET", url: "/v1/policies", headers: H })).statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });

  it("a 429 tells the caller when to come back", async () => {
    const app = await makeApp({ rateLimitPerMinute: 1 });
    await app.inject({ method: "GET", url: "/v1/policies", headers: H });
    const res = await app.inject({ method: "GET", url: "/v1/policies", headers: H });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { type: "curb_rate_limited" } });
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("the window rolls over", async () => {
    const app = await makeApp({ rateLimitPerMinute: 1 });
    await app.inject({ method: "GET", url: "/v1/policies", headers: H });
    expect((await app.inject({ method: "GET", url: "/v1/policies", headers: H })).statusCode).toBe(429);
    clock += 61_000;
    expect((await app.inject({ method: "GET", url: "/v1/policies", headers: H })).statusCode).toBe(200);
  });

  it("one project's flood does not starve another", async () => {
    // why: the limiter exists precisely so a looping agent cannot take the
    // control plane down for everyone else.
    const app = await makeApp({ rateLimitPerMinute: 2 });
    await repo.upsertProject({ id: "proj2", orgId: "org1", name: "other", apiKeyHash: hashApiKey("other-key") });

    for (let i = 0; i < 5; i++) await app.inject({ method: "GET", url: "/v1/policies", headers: H });
    const other = await app.inject({ method: "GET", url: "/v1/policies", headers: { "x-curb-key": "other-key" } });
    expect(other.statusCode).toBe(200);
  });

  it("an unauthenticated request is rejected before it can consume budget", async () => {
    const app = await makeApp({ rateLimitPerMinute: 1 });
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: "GET", url: "/v1/policies" })).statusCode).toBe(401);
    }
    // the real key still has its full budget
    expect((await app.inject({ method: "GET", url: "/v1/policies", headers: H })).statusCode).toBe(200);
  });

  it("0 disables the limiter", async () => {
    const app = await makeApp({ rateLimitPerMinute: 0 });
    for (let i = 0; i < 20; i++) {
      expect((await app.inject({ method: "GET", url: "/v1/policies", headers: H })).statusCode).toBe(200);
    }
  });
});

describe("approval expiry", () => {
  const askPolicy = {
    name: "delete_file requires approval", type: "tool_permission", action: "ask",
    scope: {}, enabled: true, params: { tools: ["delete_file"], mode: "ask" },
  };

  async function appWithPendingApproval(ttlMs: number) {
    const app = await makeApp({ approvalTtlMs: ttlMs });
    await app.inject({ method: "POST", url: "/v1/policies", headers: H, payload: askPolicy });
    const d = await app.inject({
      method: "POST", url: "/v1/decisions", headers: H,
      payload: { kind: "tool_call", runId: "r1", toolName: "delete_file" },
    });
    return { app, approvalId: (d.json() as { approvalId: string }).approvalId };
  }

  it("an approval nobody decided stops looking actionable", async () => {
    // why: the SDK gives up on its own timeout, but the row stayed 'pending' forever —
    // an operator clicking Approve was approving an agent that had long walked away.
    const { app, approvalId } = await appWithPendingApproval(60_000);
    expect((await app.inject({ method: "GET", url: `/v1/approvals/${approvalId}`, headers: H })).json().status)
      .toBe("pending");

    clock += 61_000;
    const after = await app.inject({ method: "GET", url: `/v1/approvals/${approvalId}`, headers: H });
    expect(after.json()).toMatchObject({ status: "expired", decidedBy: "curb:expiry" });
  });

  it("expired approvals leave the pending queue", async () => {
    const { app } = await appWithPendingApproval(60_000);
    expect((await app.inject({ method: "GET", url: "/v1/approvals?status=pending", headers: H })).json())
      .toHaveLength(1);
    clock += 61_000;
    expect((await app.inject({ method: "GET", url: "/v1/approvals?status=pending", headers: H })).json())
      .toHaveLength(0);
  });

  it("deciding an expired approval is refused, not silently applied", async () => {
    const { app, approvalId } = await appWithPendingApproval(60_000);
    clock += 61_000;
    const res = await app.inject({
      method: "POST", url: `/v1/approvals/${approvalId}/decide`, headers: H, payload: { approve: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ approval: { status: "expired" } });
  });

  it("a fresh approval is untouched", async () => {
    const { app, approvalId } = await appWithPendingApproval(60_000);
    clock += 30_000;
    expect((await app.inject({ method: "GET", url: `/v1/approvals/${approvalId}`, headers: H })).json().status)
      .toBe("pending");
  });

  it("expiry wakes anyone still holding a long-poll", async () => {
    const r = new MemoryRepo();
    const hub = new ApprovalHub(r);
    await r.createApproval({
      id: "apr_1", runId: "r1", projectId: "proj1", toolName: "delete_file",
      status: "pending", requestedAt: 0,
    });
    const waiting = hub.wait("apr_1", 5_000);
    await new Promise((res) => setTimeout(res, 10));

    const count = await expireApprovals(r, 100_000, 1_000, hub);
    expect(count).toBe(1);
    expect((await waiting)!.status).toBe("expired");
  });
});

describe("dashboard hardening", () => {
  it("ships a restrictive CSP and no-store, and never caches a credential", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.body).not.toContain(KEY);
  });
});
