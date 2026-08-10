import type { Approval, ApprovalStatus, Repo } from "./repo/types.js";

type Waiter = (a: Approval) => void;

/**
 * Connects the dashboard (which decides) to the SDK (which waits).
 * SDKs long-poll: one connection hangs until a decision arrives or the wait expires —
 * far cheaper and more responsive than polling every second.
 */
export class ApprovalHub {
  private waiters = new Map<string, Set<Waiter>>();

  constructor(private repo: Repo) {}

  /** Notify every waiter that an approval has been decided. */
  publish(approval: Approval): void {
    const set = this.waiters.get(approval.id);
    if (!set) return;
    this.waiters.delete(approval.id);
    for (const w of set) w(approval);
  }

  /**
   * Wait up to `timeoutMs` for a decision. On timeout it returns the approval as-is
   * (still "pending") and lets the caller decide what that means.
   */
  async wait(id: string, timeoutMs: number): Promise<Approval | null> {
    const current = await this.repo.getApproval(id);
    if (!current) return null;
    if (current.status !== "pending" || timeoutMs <= 0) return current;

    return new Promise<Approval>((resolve) => {
      let done = false;
      const finish = (a: Approval) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.unregister(id, waiter);
        resolve(a);
      };
      const waiter: Waiter = finish;
      const timer = setTimeout(() => {
        // why: return the current state rather than an error — the SDK decides for
        // itself whether to keep waiting or fall back to its fail mode.
        void this.repo.getApproval(id).then((a) => finish(a ?? current));
      }, timeoutMs);
      timer.unref?.();
      this.register(id, waiter);
    });
  }

  private register(id: string, w: Waiter) {
    let set = this.waiters.get(id);
    if (!set) {
      set = new Set();
      this.waiters.set(id, set);
    }
    set.add(w);
  }

  private unregister(id: string, w: Waiter) {
    const set = this.waiters.get(id);
    if (!set) return;
    set.delete(w);
    if (set.size === 0) this.waiters.delete(id);
  }

  pendingWaiters(id: string): number {
    return this.waiters.get(id)?.size ?? 0;
  }
}

export type { ApprovalStatus };
