import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Policy } from "@curb/shared";
import { PostgresRepo } from "./postgres.js";

/**
 * Integration against a real Postgres (migrations plus every query).
 * Skipped when DATABASE_URL is unset:
 *   docker compose up -d postgres
 *   DATABASE_URL=postgresql://curb:curb@localhost:5432/curb pnpm --filter @curb/control-plane test
 */
const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("PostgresRepo", () => {
  let repo: PostgresRepo;
  const projectId = `p_${process.pid}`;
  const runId = `r_${process.pid}`;

  const policy: Policy = {
    id: `pol_${process.pid}`, name: "cap", type: "cost_cap", scope: { project: projectId },
    params: { maxUsd: 2 }, action: "deny", enabled: true,
  };

  beforeAll(async () => {
    repo = new PostgresRepo(url!);
    await repo.init();
    await repo.upsertProject({ id: projectId, orgId: `o_${process.pid}`, name: "test" });
  });

  afterAll(async () => {
    await repo.deletePolicy(projectId, policy.id);
    await repo.close();
  });

  it("migrations are idempotent — calling init() twice does not error", async () => {
    await expect(repo.init()).resolves.toBeUndefined();
  });

  it("an API key resolves to its org, project and role", async () => {
    const hash = `h_${process.pid}`;
    await repo.createApiKey({
      id: `key_${process.pid}`,
      orgId: `o_${process.pid}`,
      projectId,
      name: "test",
      keyHash: hash,
      role: "operator",
      createdAt: Date.now(),
    });
    expect(await repo.apiKeyByHash(hash)).toMatchObject({ projectId, role: "operator" });
  });

  it("a revoked key stops resolving", async () => {
    const hash = `hr_${process.pid}`;
    const id = `keyr_${process.pid}`;
    await repo.createApiKey({
      id, orgId: `o_${process.pid}`, projectId, name: "doomed",
      keyHash: hash, role: "viewer", createdAt: Date.now(),
    });
    expect(await repo.revokeApiKey(`o_${process.pid}`, id, Date.now())).toBe(true);
    expect(await repo.apiKeyByHash(hash)).toBeNull();
    // Revoking twice is not an error the caller should act on, but it changed nothing.
    expect(await repo.revokeApiKey(`o_${process.pid}`, id, Date.now())).toBe(false);
  });

  it("a policy round-trip preserves scope/params/when JSON", async () => {
    await repo.putPolicy(projectId, { ...policy, when: { env: "prod" } });
    const back = await repo.getPolicy(projectId, policy.id);
    expect(back).toMatchObject({ params: { maxUsd: 2 }, scope: { project: projectId }, when: { env: "prod" } });
  });

  it("putPolicy twice updates rather than duplicates", async () => {
    await repo.putPolicy(projectId, { ...policy, name: "berubah" });
    const list = (await repo.listPolicies(projectId)).filter((p) => p.id === policy.id);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("berubah");
  });

  it("an event batch is stored and read back newest-first", async () => {
    await repo.appendEvents([
      { runId, projectId, ts: 1_700_000_000_000, kind: "llm_call", effect: "ALLOW" },
      { runId, projectId, ts: 1_700_000_001_000, kind: "llm_call", effect: "DENY", policyId: policy.id, reason: "cap" },
    ]);
    const events = await repo.listEvents(projectId, { runId });
    expect(events[0]).toMatchObject({ effect: "DENY", reason: "cap" });
  });

  it("a run summary only goes up, never down", async () => {
    await repo.upsertRun({ id: runId, projectId, startedAt: 1_700_000_000_000, status: "running", totalTokens: 100, totalCostUsd: 1.5, stepCount: 2 });
    await repo.upsertRun({ id: runId, projectId, startedAt: 1_700_000_000_000, status: "blocked", totalTokens: 50, totalCostUsd: 0.1, stepCount: 1, verdict: policy.id });
    const run = await repo.getRun(projectId, runId);
    expect(run).toMatchObject({ status: "blocked", totalTokens: 100, verdict: policy.id });
    expect(run!.totalCostUsd).toBeCloseTo(1.5, 6);
  });

  it("decideApproval is atomic — a second decision does not reverse it", async () => {
    const id = `apr_${process.pid}`;
    await repo.createApproval({ id, runId, projectId, toolName: "delete_file", status: "pending", requestedAt: Date.now() });
    const [a, b] = await Promise.all([
      repo.decideApproval(id, "approved", "alice", Date.now()),
      repo.decideApproval(id, "denied", "bob", Date.now()),
    ]);

    // exactly one caller may claim the decision
    expect([a.changed, b.changed].filter(Boolean)).toHaveLength(1);
    const winner = a.changed ? a : b;
    const loser = a.changed ? b : a;

    // both see the same final state, and the loser did not overwrite it
    expect(loser.approval!.status).toBe(winner.approval!.status);
    const stored = await repo.getApproval(id);
    expect(stored!.decidedBy).toBe(winner.approval!.decidedBy);
    expect(stored!.status).toBe(winner.approval!.status);
  });
});
