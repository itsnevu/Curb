import type { PolicyEvaluator } from "./index.js";

/** time_limit — DENY kalau umur run melewati maxWallClockMs. params: { maxWallClockMs } */
export const timeLimit: PolicyEvaluator = (ctx, policy, state) => {
  const maxMs = Number(policy.params.maxWallClockMs ?? Infinity);
  const now = Number(ctx.meta?.now ?? state.startedAt);
  if (now - state.startedAt >= maxMs) {
    return {
      effect: "DENY",
      policyId: policy.id,
      reason: `time_limit: run berjalan ${now - state.startedAt}ms (batas ${maxMs}ms)`,
    };
  }
  return { effect: "ALLOW" };
};
