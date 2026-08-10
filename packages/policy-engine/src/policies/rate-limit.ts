import { nowOf } from "./now.js";
import type { PolicyEvaluator } from "./index.js";

/**
 * rate_limit — a simple sliding window per run.
 * params: { maxCalls: number, perMs: number }
 * state.callTimestamps is filled by the caller (pushes `now` before evaluate).
 */
export const rateLimit: PolicyEvaluator = (ctx, policy, state) => {
  const maxCalls = Number(policy.params.maxCalls ?? Infinity);
  const perMs = Number(policy.params.perMs ?? 60_000);
  const now = nowOf(ctx, state);
  const recent = state.callTimestamps.filter((t) => now - t <= perMs);
  // why: the caller pushed this call's timestamp BEFORE evaluate, so `recent`
  // includes the current call — `>` means call number (maxCalls + 1) is the one held.
  if (recent.length > maxCalls) {
    return {
      effect: "THROTTLE",
      policyId: policy.id,
      reason: `rate_limit: ${recent.length} calls / ${perMs}ms (limit ${maxCalls})`,
      retryAfterMs: perMs,
    };
  }
  return { effect: "ALLOW" };
};
