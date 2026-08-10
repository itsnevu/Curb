export type PolicyType = "cost_cap" | "loop_detect" | "rate_limit" | "step_limit" | "time_limit" | "tool_permission";
export type Effect = "ALLOW" | "DENY" | "ASK" | "THROTTLE";
export type Action = "allow" | "deny" | "ask" | "throttle";
export interface PolicyScope {
    org?: string;
    project?: string;
    run?: string;
    tool?: string;
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
    messages?: unknown[];
    model?: string;
    estimatedTokens?: number;
    toolName?: string;
    toolArgs?: unknown;
    sensitivity?: "low" | "medium" | "high";
    /** Waktu evaluasi (ms epoch). Di-inject caller supaya engine tetap murni & deterministik di test. */
    now?: number;
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
/** Delta counter yang di-apply secara atomik setelah sebuah call selesai. */
export interface RunStateDelta {
    tokens?: number;
    costUsd?: number;
    steps?: number;
}
/** Window mana yang bisa di-push (semua bounded / capped). */
export type WindowKey = "sigWindow" | "toolWindow" | "callTimestamps";
export interface RunStateStore {
    get(runId: string): Promise<RunState>;
    save(state: RunState): Promise<void>;
    /**
     * Tambah counter secara atomik. Wajib atomik supaya beberapa instance
     * gateway tidak saling menimpa cost/step (why: cost cap bocor kalau read-modify-write).
     */
    bump(runId: string, delta: RunStateDelta): Promise<RunState>;
    /** Push ke window bounded, kembalikan isi window setelah push. */
    pushWindow(runId: string, key: WindowKey, value: string | number, cap: number): Promise<Array<string | number>>;
    /** Hapus state run (dipakai test & saat run selesai). */
    reset(runId: string): Promise<void>;
}
/** Urutan ketat: DENY > ASK > THROTTLE > ALLOW */
export declare const EFFECT_SEVERITY: Record<Effect, number>;
