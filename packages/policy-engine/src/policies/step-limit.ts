import type { PolicyEvaluator } from "./index.js";

/**
 * step_limit — DENY kalau jumlah step run melewati maxSteps. params: { maxSteps }
 * why: caller sudah menaikkan stepCount SEBELUM evaluate, jadi `>` berarti
 * "maxSteps step pertama boleh jalan, yang berikutnya ditahan".
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
