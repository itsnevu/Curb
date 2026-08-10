import type { PolicyEvaluator } from "./index.js";

/**
 * loop_detect — dua sinyal:
 *  1) semantic repeat: signature messages sama berulang >= maxRepeats dalam window.
 *  2) tool-cycle: pola tool berulang (mis. A,B,A,B,A,B).
 * params: { maxRepeats?: number (default 3), signatureWindow?: number (default 10) }
 *
 * Signature dihitung & di-push ke state.sigWindow / state.toolWindow oleh caller
 * (Gateway/SDK) SEBELUM evaluate. Di sini kita hanya membaca window.
 */
export const loopDetect: PolicyEvaluator = (_ctx, policy, state) => {
  const maxRepeats = Number(policy.params.maxRepeats ?? 3);
  const signatureWindow = Number(policy.params.signatureWindow ?? 10);

  // 1) semantic repeat — hanya lihat `signatureWindow` call terakhir,
  // why: run panjang yang sesekali mengulang pesan bukan loop.
  const window = state.sigWindow.slice(-signatureWindow);
  const last = window.at(-1);
  if (last) {
    const repeats = window.filter((s) => s === last).length;
    if (repeats >= maxRepeats) {
      return {
        effect: "DENY",
        policyId: policy.id,
        reason: `loop_detect: pesan identik berulang ${repeats}x (batas ${maxRepeats})`,
      };
    }
  }

  // 2) tool-cycle (deteksi pola periodik pendek)
  if (hasRepeatingCycle(state.toolWindow, maxRepeats)) {
    return {
      effect: "DENY",
      policyId: policy.id,
      reason: `loop_detect: siklus tool berulang terdeteksi (${state.toolWindow.slice(-6).join("→")})`,
    };
  }

  return { effect: "ALLOW" };
};

/** True kalau ada blok berukuran 1..3 yang berulang >= repeats kali di ekor window. */
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
