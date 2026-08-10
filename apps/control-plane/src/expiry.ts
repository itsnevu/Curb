import type { ApprovalHub } from "./approval-hub.js";
import type { Repo } from "./repo/types.js";

/**
 * Age out approvals nobody decided.
 *
 * why: the SDK gives up after its own timeout, but the row stayed `pending` forever —
 * the queue filled with requests whose agent had long since walked away, and an
 * operator clicking Approve was approving nothing. Expiring them keeps the queue
 * honest, and wakes any waiter still holding a long-poll.
 */
export async function expireApprovals(
  repo: Repo,
  now: number,
  ttlMs: number,
  hub?: ApprovalHub,
): Promise<number> {
  const stale = await repo.expirePendingApprovals(now - ttlMs, now);
  for (const approval of stale) hub?.publish(approval);
  return stale.length;
}

/**
 * The same sweep, but at most once per `everyMs`.
 *
 * why: it hangs off a request hook, and /v1/decisions is called for every guarded tool
 * call. Sweeping on each one would put a write against the approvals table in the hot
 * path of every decision, to catch something that only changes on the scale of minutes.
 */
export function throttledExpiry(
  repo: Repo,
  ttlMs: number,
  hub: ApprovalHub,
  everyMs = 30_000,
): (now: number) => Promise<void> {
  let lastRun = -Infinity;
  let inFlight: Promise<unknown> | null = null;

  return async (now: number) => {
    if (inFlight || now - lastRun < everyMs) return;
    lastRun = now;
    inFlight = expireApprovals(repo, now, ttlMs, hub).finally(() => {
      inFlight = null;
    });
    await inFlight;
  };
}
