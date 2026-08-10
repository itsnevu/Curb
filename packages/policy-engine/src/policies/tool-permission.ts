import type { PolicyEvaluator } from "./index.js";

/**
 * tool_permission — the guardrail / ask-before-acting policy. Only applies when
 * ctx.kind === "tool_call".
 * params: { tools?: string[], sensitivity?: "low"|"medium"|"high", mode?: "ask"|"deny"|"allow" }
 *
 * The tool matches by name or by sensitivity. What happens then comes from
 * `policy.action`, exactly like every other policy type; `params.mode` stays supported
 * as an explicit per-policy override (marked `final` so the engine leaves it alone).
 */
export const toolPermission: PolicyEvaluator = (ctx, policy) => {
  if (ctx.kind !== "tool_call") return { effect: "ALLOW" };

  const tools = (policy.params.tools as string[] | undefined) ?? [];
  const wantSensitivity = policy.params.sensitivity as string | undefined;
  const mode = policy.params.mode as string | undefined;

  const matchByName = tools.length > 0 && ctx.toolName && tools.includes(ctx.toolName);
  const matchBySens = wantSensitivity && ctx.sensitivity === wantSensitivity;
  if (!matchByName && !matchBySens) return { effect: "ALLOW" };

  if (mode === "allow") return { effect: "ALLOW" };
  if (mode === "deny")
    return { effect: "DENY", final: true, policyId: policy.id, reason: `tool_permission: '${ctx.toolName}' is blocked` };
  if (mode === "ask")
    return {
      effect: "ASK",
      final: true,
      policyId: policy.id,
      reason: `tool_permission: '${ctx.toolName}' requires approval`,
    };

  // No mode → the action decides. ASK is the natural wording for the default.
  return { effect: "ASK", policyId: policy.id, reason: `tool_permission: '${ctx.toolName}' matched this policy` };
};
