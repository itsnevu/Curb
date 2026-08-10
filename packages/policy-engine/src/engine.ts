import {
  type Context,
  type Decision,
  type Policy,
  type RunState,
  ACTION_EFFECT,
  EFFECT_SEVERITY,
} from "@curb/shared";
import { POLICY_EVALUATORS } from "./policies/index.js";

/**
 * The heart of Curb. Pure and synchronous: it knows nothing about HTTP or databases.
 * Selects the policies that match (scope + when), evaluates each one, and returns
 * the STRICTEST decision (DENY > ASK > THROTTLE > ALLOW).
 *
 * Division of labour: an evaluator decides *whether* its rule is broken, `policy.action`
 * decides *what happens* when it is. That is why the same `cost_cap` can deny for one
 * team and merely throttle for another, with no change to the evaluator.
 */
export function evaluate(
  ctx: Context,
  policies: Policy[],
  state: RunState,
): Decision {
  let worst: Decision = { effect: "ALLOW" };

  for (const policy of policies) {
    if (!policy.enabled) continue;
    if (!scopeMatches(policy, ctx)) continue;
    if (!whenMatches(policy, ctx)) continue;

    const evaluator = POLICY_EVALUATORS[policy.type];
    if (!evaluator) continue;

    const d = applyAction(policy, evaluator(ctx, policy, state));
    if (EFFECT_SEVERITY[d.effect] > EFFECT_SEVERITY[worst.effect]) {
      worst = d;
    }
  }
  const { final: _final, ...decision } = worst;
  return decision;
}

/** Turn "this rule is broken" into the effect the operator configured. */
function applyAction(policy: Policy, d: Decision): Decision {
  if (d.effect === "ALLOW" || d.final) return d;
  const effect = ACTION_EFFECT[policy.action] ?? d.effect;
  return {
    ...d,
    effect,
    // retryAfterMs only means something for a THROTTLE.
    retryAfterMs: effect === "THROTTLE" ? d.retryAfterMs : undefined,
  };
}

function scopeMatches(policy: Policy, ctx: Context): boolean {
  const s = policy.scope;
  if (s.org && s.org !== ctx.org) return false;
  if (s.project && s.project !== ctx.projectId) return false;
  if (s.run && s.run !== ctx.runId) return false;
  if (s.tool && s.tool !== ctx.toolName) return false;
  return true;
}

function whenMatches(policy: Policy, ctx: Context): boolean {
  if (!policy.when) return true;
  const meta = { env: ctx.env, ...(ctx.meta ?? {}) } as Record<string, unknown>;
  return Object.entries(policy.when).every(([k, v]) => meta[k] === v);
}
