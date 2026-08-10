import type { Policy } from "@curb/shared";
import type {
  Approval,
  ApprovalStatus,
  DecideResult,
  EventRecord,
  Project,
  Repo,
  RunSummary,
} from "./types.js";

/** In-memory repo: used by tests and by dev mode without Postgres. */
export class MemoryRepo implements Repo {
  private projects = new Map<string, Project>();
  private policies = new Map<string, Map<string, Policy>>();
  private events: EventRecord[] = [];
  private approvals = new Map<string, Approval>();
  private runs = new Map<string, RunSummary>();
  private seq = 0;

  async init() {}
  async close() {}

  async projectByApiKeyHash(hash: string): Promise<Project | null> {
    return [...this.projects.values()].find((p) => p.apiKeyHash === hash) ?? null;
  }
  async upsertProject(p: Project): Promise<Project> {
    this.projects.set(p.id, p);
    return p;
  }

  private bucket(projectId: string) {
    let b = this.policies.get(projectId);
    if (!b) {
      b = new Map();
      this.policies.set(projectId, b);
    }
    return b;
  }

  async listPolicies(projectId: string) {
    return [...this.bucket(projectId).values()];
  }
  async getPolicy(projectId: string, id: string) {
    return this.bucket(projectId).get(id) ?? null;
  }
  async putPolicy(projectId: string, policy: Policy) {
    this.bucket(projectId).set(policy.id, policy);
    return policy;
  }
  async deletePolicy(projectId: string, id: string) {
    return this.bucket(projectId).delete(id);
  }

  async appendEvents(events: EventRecord[]) {
    for (const e of events) this.events.push({ ...e, id: ++this.seq });
  }
  async listEvents(projectId: string, opts: { runId?: string; limit?: number } = {}) {
    return this.events
      .filter((e) => (e.projectId ?? projectId) === projectId)
      .filter((e) => !opts.runId || e.runId === opts.runId)
      .sort((a, b) => b.ts - a.ts || (b.id ?? 0) - (a.id ?? 0))
      .slice(0, opts.limit ?? 100);
  }

  async createApproval(a: Approval) {
    this.approvals.set(a.id, a);
    return a;
  }
  async getApproval(id: string) {
    return this.approvals.get(id) ?? null;
  }
  async listApprovals(projectId: string, status?: ApprovalStatus) {
    return [...this.approvals.values()]
      .filter((a) => (a.projectId ?? projectId) === projectId)
      .filter((a) => !status || a.status === status)
      .sort((a, b) => b.requestedAt - a.requestedAt);
  }
  async decideApproval(id: string, status: ApprovalStatus, by: string, at: number): Promise<DecideResult> {
    const a = this.approvals.get(id);
    if (!a) return { approval: null, changed: false };
    // why: the first decision wins — approve/deny must not be reversible.
    if (a.status !== "pending") return { approval: a, changed: false };
    const next = { ...a, status, decidedBy: by, decidedAt: at };
    this.approvals.set(id, next);
    return { approval: next, changed: true };
  }

  async expirePendingApprovals(before: number, at: number): Promise<Approval[]> {
    const expired: Approval[] = [];
    for (const [id, a] of this.approvals) {
      if (a.status !== "pending" || a.requestedAt > before) continue;
      const next: Approval = { ...a, status: "expired", decidedAt: at, decidedBy: "curb:expiry" };
      this.approvals.set(id, next);
      expired.push(next);
    }
    return expired;
  }

  async upsertRun(run: RunSummary) {
    const prev = this.runs.get(run.id);
    if (!prev) {
      this.runs.set(run.id, run);
      return;
    }
    // why: counters only ever grow. Events arrive out of order (the gateway batches
    // them), and a late event carrying a smaller snapshot must not rewind a run's
    // totals. Mirrors the GREATEST()/COALESCE() in the Postgres upsert.
    this.runs.set(run.id, {
      ...prev,
      ...run,
      startedAt: Math.min(prev.startedAt, run.startedAt),
      endedAt: run.endedAt ?? prev.endedAt,
      totalTokens: Math.max(prev.totalTokens, run.totalTokens),
      totalCostUsd: Math.max(prev.totalCostUsd, run.totalCostUsd),
      stepCount: Math.max(prev.stepCount, run.stepCount),
      verdict: run.verdict ?? prev.verdict,
    });
  }
  async listRuns(projectId: string, limit = 50) {
    return [...this.runs.values()]
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }
  async getRun(projectId: string, id: string) {
    const r = this.runs.get(id);
    return r && r.projectId === projectId ? r : null;
  }
}
