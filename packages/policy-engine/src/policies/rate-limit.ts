import { nowOf } from "./now.js";
import type { PolicyEvaluator } from "./index.js";

/**
 * rate_limit — sliding window sederhana per run.
 * params: { maxCalls: number, perMs: number }
 * state.callTimestamps diisi caller (push now sebelum evaluate).
 */
export const rateLimit: PolicyEvaluator = (ctx, policy, state) => {
  const maxCalls = Number(policy.params.maxCalls ?? Infinity);
  const perMs = Number(policy.params.perMs ?? 60_000);
  const now = nowOf(ctx, state);
  const recent = state.callTimestamps.filter((t) => now - t <= perMs);
  // why: caller sudah push timestamp call ini SEBELUM evaluate, jadi `recent`
  // termasuk call sekarang — `>` berarti "call ke-(maxCalls+1)" yang ditahan.
  if (recent.length > maxCalls) {
    return {
      effect: "THROTTLE",
      policyId: policy.id,
      reason: `rate_limit: ${recent.length} call / ${perMs}ms (batas ${maxCalls})`,
      retryAfterMs: perMs,
    };
  }
  return { effect: "ALLOW" };
};
