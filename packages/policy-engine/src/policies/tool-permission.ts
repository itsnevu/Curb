import type { PolicyEvaluator } from "./index.js";

/**
 * tool_permission — guardrail / ask-before-acting. Hanya untuk ctx.kind === "tool_call".
 * params: { tools?: string[], sensitivity?: "low"|"medium"|"high", mode: "ask"|"deny"|"allow" }
 * Kalau tool cocok → terapkan mode. "ask" → ASK (SDK bikin approval & tahan eksekusi).
 */
export const toolPermission: PolicyEvaluator = (ctx, policy) => {
  if (ctx.kind !== "tool_call") return { effect: "ALLOW" };

  const tools = (policy.params.tools as string[] | undefined) ?? [];
  const wantSensitivity = policy.params.sensitivity as string | undefined;
  const mode = (policy.params.mode as string) ?? "ask";

  const matchByName = tools.length > 0 && ctx.toolName && tools.includes(ctx.toolName);
  const matchBySens = wantSensitivity && ctx.sensitivity === wantSensitivity;
  if (!matchByName && !matchBySens) return { effect: "ALLOW" };

  if (mode === "deny")
    return { effect: "DENY", policyId: policy.id, reason: `tool_permission: '${ctx.toolName}' diblokir` };
  if (mode === "ask")
    return { effect: "ASK", policyId: policy.id, reason: `tool_permission: '${ctx.toolName}' butuh persetujuan` };
  return { effect: "ALLOW" };
};
