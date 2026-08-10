import type { Context, Decision, Policy, PolicyType, RunState } from "@curb/shared";
import { costCap } from "./cost-cap.js";
import { loopDetect } from "./loop-detect.js";
import { stepLimit } from "./step-limit.js";
import { rateLimit } from "./rate-limit.js";
import { timeLimit } from "./time-limit.js";
import { toolPermission } from "./tool-permission.js";

export type PolicyEvaluator = (
  ctx: Context,
  policy: Policy,
  state: RunState,
) => Decision;

/** Registry: nambah policy type = nambah satu entri di sini. */
export const POLICY_EVALUATORS: Record<PolicyType, PolicyEvaluator> = {
  cost_cap: costCap,
  loop_detect: loopDetect,
  step_limit: stepLimit,
  rate_limit: rateLimit,
  time_limit: timeLimit,
  tool_permission: toolPermission,
};

export { costCap, loopDetect, stepLimit, rateLimit, timeLimit, toolPermission };
