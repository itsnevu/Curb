import type { PolicyEvaluator } from "./index.js";

/**
 * loop_detect — two signals:
 *  1) semantic repeat: the same message signature appears >= maxRepeats times in the window.
 *  2) tool cycle: a repeating tool pattern (e.g. A,B,A,B,A,B).
 * params: { maxRepeats?: number (default 3), signatureWindow?: number (default 10) }
 *
 * Signatures are computed and pushed onto state.sigWindow / state.toolWindow by the
 * caller (gateway or SDK) BEFORE evaluate runs. Here we only read the windows.
 */
export const loopDetect: PolicyEvaluator = (_ctx, policy, state) => {
  const maxRepeats = Number(policy.params.maxRepeats ?? 3);
  const signatureWindow = Number(policy.params.signatureWindow ?? 10);

  // 1) semantic repeat — only look at the last `signatureWindow` calls.
  // why: a long run that occasionally repeats a message is not a loop.
  const window = state.sigWindow.slice(-signatureWindow);
  const last = window.at(-1);
  if (last) {
    const repeats = window.filter((s) => s === last).length;
    if (repeats >= maxRepeats) {
      return {
        effect: "DENY",
        policyId: policy.id,
        reason: `loop_detect: identical message repeated ${repeats}x (limit ${maxRepeats})`,
      };
    }
  }

  // 2) tool cycle (detect short periodic patterns)
  if (hasRepeatingCycle(state.toolWindow, maxRepeats)) {
    return {
      effect: "DENY",
      policyId: policy.id,
      reason: `loop_detect: repeating tool cycle detected (${state.toolWindow.slice(-6).join("→")})`,
    };
  }

  return { effect: "ALLOW" };
};

/** True if a block of size 1..3 repeats >= `repeats` times at the tail of the window. */
function hasRepeatingCycle(seq: string[], repeats: number): boolean {
  for (let size = 1; size <= 3; size++) {
    if (seq.length < size * repeats) continue;
    const tail = seq.slice(-size * repeats);
    const block = tail.slice(0, size).join(",");
    let ok = true;
    for (let i = 0; i < repeats; i++) {
      if (tail.slice(i * size, (i + 1) * size).join(",") !== block) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}
