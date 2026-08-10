import type { PolicyEvaluator } from "./index.js";

/** step_limit — DENY kalau jumlah step run melewati maxSteps. params: { maxSteps } */
export const stepLimit: PolicyEvaluator = (_ctx, policy, state) => {
  const maxSteps = Number(policy.params.maxSteps ?? Infinity);
  if (state.stepCount >= maxSteps) {
    return {
      effect: "DENY",
      policyId: policy.id,
      reason: `step_limit: run mencapai ${state.stepCount} step (batas ${maxSteps})`,
    };
  }
  return { effect: "ALLOW" };
};
