import type { Context, RunState } from "@curb/shared";

/**
 * Waktu evaluasi. Engine tidak boleh memanggil Date.now() sendiri (harus murni),
 * jadi caller meng-inject lewat ctx.now. Fallback ke startedAt = "belum lewat waktu".
 */
export function nowOf(ctx: Context, state: RunState): number {
  return Number(ctx.now ?? ctx.meta?.now ?? state.startedAt);
}
