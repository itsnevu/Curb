import type { Context, RunState } from "@curb/shared";

/**
 * Evaluation time. The engine must never call Date.now() itself (it has to stay pure),
 * so callers inject it via ctx.now. Falling back to startedAt means "no time has passed".
 */
export function nowOf(ctx: Context, state: RunState): number {
  return Number(ctx.now ?? ctx.meta?.now ?? state.startedAt);
}
