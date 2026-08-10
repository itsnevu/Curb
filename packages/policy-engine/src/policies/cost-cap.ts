import type { PolicyEvaluator } from "./index.js";

/**
 * cost_cap — trips once a run's total cost passes maxUsd.
 * params: { maxUsd: number, window?: "run" }  (MVP: window=run)
 * Note: state.costUsd is updated by the gateway AFTER each provider response,
 * which is why this compares with >= rather than >.
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
