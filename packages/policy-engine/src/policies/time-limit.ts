import { nowOf } from "./now.js";
import type { PolicyEvaluator } from "./index.js";

/** time_limit — DENY once a run is older than maxWallClockMs. params: { maxWallClockMs } */
export const timeLimit: PolicyEvaluator = (ctx, policy, state) => {
  const maxMs = Number(policy.params.maxWallClockMs ?? Infinity);
  const now = nowOf(ctx, state);
  if (now - state.startedAt >= maxMs) {
    return {
      effect: "DENY",
      policyId: policy.id,
      reason: `time_limit: run has been going ${now - state.startedAt}ms (limit ${maxMs}ms)`,
    };
  }
  return { effect: "ALLOW" };
};
