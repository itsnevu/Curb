// ── Core Curb types. Shared by the engine, gateway, control plane and SDKs. ──

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
  tool?: string; // for tool_permission
}

/** Optional extra condition, e.g. { env: "prod" }. Evaluated against ctx.meta. */
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

/** What is being evaluated. */
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
  /**
   * Worst-case cost of the call about to be made, in USD. The caller estimates it
   * BEFORE forwarding so a cost cap can hold the call instead of discovering the
   * overshoot afterwards. See `cost_cap`.
   */
  estimatedCostUsd?: number;
  /** Cost already spent inside wider windows (used by cost_cap window: hour/day). */
  costWindows?: { hour?: number; day?: number };
  /** Loop-detection signature of this call, when the caller can compute one. */
  signature?: string;
  // tool_call:
  toolName?: string;
  toolArgs?: unknown;
  sensitivity?: "low" | "medium" | "high";
  /** Evaluation time (epoch ms). Injected by the caller so the engine stays pure and tests stay deterministic. */
  now?: number;
  meta?: Record<string, unknown>;
}

export interface Decision {
  effect: Effect;
  policyId?: string;
  reason?: string;
  retryAfterMs?: number;
  /**
   * Internal: the evaluator already resolved the effect itself (e.g. tool_permission
   * with an explicit `mode`), so the engine must not remap it from `policy.action`.
   * Stripped before a decision leaves the engine.
   */
  final?: boolean;
}

/** Per-run state (Redis / in-memory). Ephemeral. */
export interface RunState {
  runId: string;
  startedAt: number;
  tokens: number;
  costUsd: number;
  stepCount: number;
  /** signatures of recent LLM messages (for loop detection) */
  sigWindow: string[];
  /** recent tool names in order (for tool-cycle detection) */
  toolWindow: string[];
  /** timestamps of recent calls (for rate limiting) */
  callTimestamps: number[];
}

/** Counter delta applied atomically once a call completes. */
export interface RunStateDelta {
  tokens?: number;
  costUsd?: number;
  steps?: number;
}

/** Which windows can be pushed to (all bounded / capped). */
export type WindowKey = "sigWindow" | "toolWindow" | "callTimestamps";

/** A cost counter wider than a single run (e.g. "project X, this hour"). */
export interface CostWindowKey {
  /** Stable identifier of the bucket, e.g. `proj:hour:483210`. */
  bucket: string;
  /** How long the bucket should survive, in seconds. */
  ttlSeconds: number;
}

export interface RunStateStore {
  get(runId: string): Promise<RunState>;
  save(state: RunState): Promise<void>;
  /**
   * Increment counters atomically. This must be atomic so that multiple gateway
   * instances don't overwrite each other's cost/step counts — a read-modify-write
   * here is exactly how a cost cap leaks.
   */
  bump(runId: string, delta: RunStateDelta): Promise<RunState>;
  /** Push onto a bounded window; returns the window contents after the push. */
  pushWindow(
    runId: string,
    key: WindowKey,
    value: string | number,
    cap: number,
  ): Promise<Array<string | number>>;
  /** Drop a run's state (used by tests and when a run finishes). */
  reset(runId: string): Promise<void>;

  /** Add to a cost bucket wider than one run, and return the new total. */
  bumpCost(key: CostWindowKey, costUsd: number): Promise<number>;
  /** Read a cost bucket. Returns 0 when the bucket has expired or never existed. */
  getCost(bucket: string): Promise<number>;
}

/** Strictness order: DENY > ASK > THROTTLE > ALLOW */
export const EFFECT_SEVERITY: Record<Effect, number> = {
  DENY: 3,
  ASK: 2,
  THROTTLE: 1,
  ALLOW: 0,
};

/**
 * What a policy does when it trips. This is the ONLY place `policy.action` becomes an
 * effect — evaluators decide *whether* a rule is broken, the action decides *what happens*.
 */
export const ACTION_EFFECT: Record<Action, Effect> = {
  deny: "DENY",
  ask: "ASK",
  throttle: "THROTTLE",
  allow: "ALLOW",
};
