import type { PolicyEvaluator } from "./index.js";

/**
 * cost_cap — the money breaker.
 * params: { maxUsd: number, window?: "run" | "hour" | "day", preflight?: boolean }
 *
 * Two guards, because after-the-fact accounting alone is not a cap:
 *  1. spent  — cost already recorded for the window has reached maxUsd.
 *  2. preflight — cost already spent PLUS the estimated cost of the call about to be
 *     made would break the cap. Without this, a single expensive call can blow through
 *     a $2 cap by any amount and we only find out once the money is gone.
 *
 * `ctx.estimatedCostUsd` is supplied by the enforcement point (the gateway prices the
 * request before forwarding it). When it is absent, only guard 1 applies.
 */
export const costCap: PolicyEvaluator = (ctx, policy, state) => {
  const maxUsd = Number(policy.params.maxUsd ?? Infinity);
  const window = (policy.params.window as string) ?? "run";
  const preflight = policy.params.preflight !== false;

  const spent = spentIn(window, ctx, state);
  const scope = window === "run" ? "run" : `last ${window}`;

  if (spent >= maxUsd) {
    return {
      effect: "DENY",
      policyId: policy.id,
      reason: `cost_cap: ${scope} reached $${spent.toFixed(4)} (limit $${maxUsd})`,
    };
  }

  const estimate = Number(ctx.estimatedCostUsd ?? 0);
  if (preflight && estimate > 0 && spent + estimate > maxUsd) {
    return {
      effect: "DENY",
      policyId: policy.id,
      reason:
        `cost_cap: this call is estimated at $${estimate.toFixed(4)} and would take the ` +
        `${scope} to $${(spent + estimate).toFixed(4)} (limit $${maxUsd})`,
    };
  }

  return { effect: "ALLOW" };
};

function spentIn(window: string, ctx: Parameters<PolicyEvaluator>[0], state: Parameters<PolicyEvaluator>[2]): number {
  if (window === "hour") return Number(ctx.costWindows?.hour ?? 0);
  if (window === "day") return Number(ctx.costWindows?.day ?? 0);
  return state.costUsd;
}
