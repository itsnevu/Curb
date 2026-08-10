import type { PolicyEvaluator } from "./index.js";

/**
 * cost_cap — trip kalau total biaya run melewati maxUsd.
 * params: { maxUsd: number, window?: "run" }  (MVP: window=run)
 * Catatan: state.costUsd di-update oleh Gateway SETELAH tiap response provider.
 */
export const costCap: PolicyEvaluator = (_ctx, policy, state) => {
  const maxUsd = Number(policy.params.maxUsd ?? Infinity);
  if (state.costUsd >= maxUsd) {
    return {
      effect: "DENY",
      policyId: policy.id,
      reason: `cost_cap: run reached $${state.costUsd.toFixed(4)} (limit $${maxUsd})`,
    };
  }
  return { effect: "ALLOW" };
};
