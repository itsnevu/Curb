import type { Decision } from "@curb/shared";
import type { Provider } from "./providers.js";

/** Which policies mean "forbidden" (403) rather than "too many / too expensive" (429). */
const FORBIDDEN_POLICIES = ["tool_permission"];

export function statusForDecision(decision: Decision, policyType?: string): number {
  if (decision.effect === "THROTTLE") return 429;
  // ASK has no meaning on an LLM call: there is nobody to hold the HTTP request open for.
  // The gateway refuses it and says so; ask-before-acting belongs to the SDK.
  if (decision.effect === "ASK") return 403;
  return policyType && FORBIDDEN_POLICIES.includes(policyType) ? 403 : 429;
}

/**
 * The error shape mirrors the provider's own, so client SDKs (openai/anthropic)
 * surface it as a normal error instead of crashing while parsing.
 */
export function errorBody(provider: Provider, decision: Decision) {
  const message =
    decision.effect === "ASK"
      ? `Curb policy: ${decision.reason ?? "request blocked"} — approval cannot be requested for an LLM call; use the Curb SDK to gate the tool instead`
      : `Curb policy: ${decision.reason ?? "request blocked"}`;
  if (provider === "anthropic") {
    return {
      type: "error",
      error: { type: "rate_limit_error", message },
      curb: { policyId: decision.policyId, effect: decision.effect },
    };
  }
  return {
    error: {
      message,
      type: "curb_policy_violation",
      param: null,
      code: decision.policyId ?? "curb_policy",
    },
    curb: { policyId: decision.policyId, effect: decision.effect },
  };
}
