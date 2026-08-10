// ── Tipe inti Curb. Dipakai bersama oleh engine, gateway, control-plane, sdk. ──

export type PolicyType =
  | "cost_cap"
  | "loop_detect"
  | "rate_limit"
  | "step_limit"
  | "time_limit"
  | "tool_permission";

export type Effect = "ALLOW" | "DENY" | "ASK" | "THROTTLE";
export type Action = "allow" | "deny" | "ask" | "throttle";

export interface PolicyScope {
  org?: string;
  project?: string;
  run?: string;
  tool?: string; // untuk tool_permission
}

/** Kondisi opsional tambahan, mis. { env: "prod" }. Dievaluasi terhadap ctx.meta. */
export type Condition = Record<string, unknown>;

export interface Policy {
  id: string;
  name: string;
  type: PolicyType;
  scope: PolicyScope;
  when?: Condition;
  params: Record<string, unknown>;
  action: Action;
  enabled: boolean;
}

/** Apa yang sedang dievaluasi. */
export type ContextKind = "llm_call" | "tool_call" | "step";

export interface Context {
  kind: ContextKind;
  runId: string;
  projectId?: string;
  org?: string;
  env?: string;
  // llm_call:
  messages?: unknown[];
  model?: string;
  estimatedTokens?: number;
  // tool_call:
  toolName?: string;
  toolArgs?: unknown;
  sensitivity?: "low" | "medium" | "high";
  meta?: Record<string, unknown>;
}

export interface Decision {
  effect: Effect;
  policyId?: string;
  reason?: string;
  retryAfterMs?: number;
}

/** State per-run (Redis / in-memory). Ephemeral. */
export interface RunState {
  runId: string;
  startedAt: number;
  tokens: number;
  costUsd: number;
  stepCount: number;
  /** signature pesan LLM terakhir (untuk loop detect) */
  sigWindow: string[];
  /** urutan nama tool terakhir (untuk tool-cycle detect) */
  toolWindow: string[];
  /** timestamp call terakhir per window key (untuk rate limit) */
  callTimestamps: number[];
}

export interface RunStateStore {
  get(runId: string): Promise<RunState>;
  save(state: RunState): Promise<void>;
}

/** Urutan ketat: DENY > ASK > THROTTLE > ALLOW */
export const EFFECT_SEVERITY: Record<Effect, number> = {
  DENY: 3,
  ASK: 2,
  THROTTLE: 1,
  ALLOW: 0,
};
