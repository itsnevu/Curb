import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Policy } from "@curb/shared";
import { PostgresRepo } from "./postgres.js";

/**
 * Integrasi lawan Postgres sungguhan (migrasi + semua query).
 * Dilewati kalau DATABASE_URL tidak diset:
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
    await repo.upsertProject({ id: projectId, orgId: `o_${process.pid}`, name: "test", apiKeyHash: `h_${process.pid}` });
  });

  afterAll(async () => {
    await repo.deletePolicy(projectId, policy.id);
    await repo.close();
  });

  it("migrasi idempoten — init() dua kali tidak error", async () => {
    await expect(repo.init()).resolves.toBeUndefined();
  });

  it("project bisa dicari lewat hash api key", async () => {
    const p = await repo.projectByApiKeyHash(`h_${process.pid}`);
    expect(p).toMatchObject({ id: projectId });
  });

  it("policy round-trip menjaga JSON scope/params/when", async () => {
    await repo.putPolicy(projectId, { ...policy, when: { env: "prod" } });
    const back = await repo.getPolicy(projectId, policy.id);
    expect(back).toMatchObject({ params: { maxUsd: 2 }, scope: { project: projectId }, when: { env: "prod" } });
  });

  it("putPolicy dua kali = update, bukan duplikat", async () => {
    await repo.putPolicy(projectId, { ...policy, name: "berubah" });
    const list = (await repo.listPolicies(projectId)).filter((p) => p.id === policy.id);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("berubah");
  });

  it("batch event tersimpan dan terbaca urut terbaru dulu", async () => {
    await repo.appendEvents([
      { runId, projectId, ts: 1_700_000_000_000, kind: "llm_call", effect: "ALLOW" },
      { runId, projectId, ts: 1_700_000_001_000, kind: "llm_call", effect: "DENY", policyId: policy.id, reason: "cap" },
    ]);
    const events = await repo.listEvents(projectId, { runId });
    expect(events[0]).toMatchObject({ effect: "DENY", reason: "cap" });
  });

  it("run summary hanya naik, tidak pernah turun", async () => {
    await repo.upsertRun({ id: runId, projectId, startedAt: 1_700_000_000_000, status: "running", totalTokens: 100, totalCostUsd: 1.5, stepCount: 2 });
    await repo.upsertRun({ id: runId, projectId, startedAt: 1_700_000_000_000, status: "blocked", totalTokens: 50, totalCostUsd: 0.1, stepCount: 1, verdict: policy.id });
    const run = await repo.getRun(projectId, runId);
    expect(run).toMatchObject({ status: "blocked", totalTokens: 100, verdict: policy.id });
    expect(run!.totalCostUsd).toBeCloseTo(1.5, 6);
  });

  it("decideApproval atomik — keputusan kedua tidak membalikkan", async () => {
    const id = `apr_${process.pid}`;
    await repo.createApproval({ id, runId, projectId, toolName: "delete_file", status: "pending", requestedAt: Date.now() });
    const [a, b] = await Promise.all([
      repo.decideApproval(id, "approved", "budi", Date.now()),
      repo.decideApproval(id, "denied", "siti", Date.now()),
    ]);
    expect(a!.status).toBe(b!.status);
    expect((await repo.getApproval(id))!.decidedBy).toBe(a!.decidedBy);
  });
});
