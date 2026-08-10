import type { PolicyEvaluator } from "./index.js";

/**
 * step_limit — DENY once a run exceeds maxSteps. params: { maxSteps }
 * why: the caller already incremented stepCount BEFORE evaluate, so `>` means
 * "the first maxSteps steps are allowed, the next one is held".
 */
export const stepLimit: PolicyEvaluator = (_ctx, policy, state) => {
  const maxSteps = Number(policy.params.maxSteps ?? Infinity);
  if (state.stepCount > maxSteps) {
    return {
      effect: "DENY",
      policyId: policy.id,
      reason: `step_limit: run reached ${state.stepCount} steps (limit ${maxSteps})`,
    };
  }
  return { effect: "ALLOW" };
};
