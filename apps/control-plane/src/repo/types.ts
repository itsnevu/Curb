import type { Policy } from "@curb/shared";

export interface Project {
  id: string;
  orgId: string;
  name: string;
  apiKeyHash: string;
}

export interface EventRecord {
  id?: number;
  runId: string;
  projectId?: string;
  ts: number;
  kind: string;
  effect: string;
  policyId?: string;
  reason?: string;
  context?: Record<string, unknown>;
  decision?: Record<string, unknown>;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface Approval {
  id: string;
  runId: string;
  projectId?: string;
  toolName: string;
  args?: Record<string, unknown>;
  reason?: string;
  policyId?: string;
  status: ApprovalStatus;
  requestedAt: number;
  decidedAt?: number;
  decidedBy?: string;
}

export interface DecideResult {
  approval: Approval | null;
  /** True only when THIS call moved the approval out of `pending`. */
  changed: boolean;
}

export interface RunSummary {
  id: string;
  projectId: string;
  startedAt: number;
  endedAt?: number;
  status: string;
  totalTokens: number;
  totalCostUsd: number;
  stepCount: number;
  verdict?: string;
}

/**
 * The only door to storage. Two implementations exist (Postgres and in-memory) so the
 * whole API can be tested end-to-end without a live database.
 */
export interface Repo {
  init(): Promise<void>;
  close(): Promise<void>;

  projectByApiKeyHash(hash: string): Promise<Project | null>;
  upsertProject(p: Project): Promise<Project>;

  listPolicies(projectId: string): Promise<Policy[]>;
  getPolicy(projectId: string, id: string): Promise<Policy | null>;
  putPolicy(projectId: string, policy: Policy): Promise<Policy>;
  deletePolicy(projectId: string, id: string): Promise<boolean>;

  appendEvents(events: EventRecord[]): Promise<void>;
  listEvents(projectId: string, opts?: { runId?: string; limit?: number }): Promise<EventRecord[]>;

  createApproval(a: Approval): Promise<Approval>;
  getApproval(id: string): Promise<Approval | null>;
  listApprovals(projectId: string, status?: ApprovalStatus): Promise<Approval[]>;
  /**
   * Decide a pending approval. `changed` is false when it had already been decided —
   * the caller must not emit a second audit event or wake waiters again for it.
   */
  decideApproval(
    id: string,
    status: ApprovalStatus,
    by: string,
    at: number,
  ): Promise<DecideResult>;
  /** Mark every approval still pending and requested before `before` as expired. */
  expirePendingApprovals(before: number, at: number): Promise<Approval[]>;

  upsertRun(run: RunSummary): Promise<void>;
  listRuns(projectId: string, limit?: number): Promise<RunSummary[]>;
  getRun(projectId: string, id: string): Promise<RunSummary | null>;
}
