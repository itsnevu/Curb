import type { Decision } from "@curb/shared";
import type { Provider } from "./providers.js";

/** Policy mana yang artinya "dilarang" (403) vs "terlalu banyak/mahal" (429). */
const FORBIDDEN_POLICIES = ["tool_permission"];

export function statusForDecision(decision: Decision, policyType?: string): number {
  if (decision.effect === "THROTTLE") return 429;
  return policyType && FORBIDDEN_POLICIES.includes(policyType) ? 403 : 429;
}

/**
 * Bentuk error ditiru dari provider supaya SDK klien (openai/anthropic)
 * memunculkannya sebagai error normal, bukan crash parsing.
 */
export function errorBody(provider: Provider, decision: Decision) {
  const message = `Curb policy: ${decision.reason ?? "request blocked"}`;
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
