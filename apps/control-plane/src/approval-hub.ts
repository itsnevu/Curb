import type { Approval, ApprovalStatus, Repo } from "./repo/types.js";

type Waiter = (a: Approval) => void;

/**
 * Menghubungkan dashboard (yang memutuskan) dengan SDK (yang menunggu).
 * SDK long-poll: satu koneksi menggantung sampai ada keputusan atau timeout —
 * jauh lebih hemat dan responsif dibanding polling tiap detik.
 */
export class ApprovalHub {
  private waiters = new Map<string, Set<Waiter>>();

  constructor(private repo: Repo) {}

  /** Beritahu semua penunggu bahwa approval sudah diputuskan. */
  publish(approval: Approval): void {
    const set = this.waiters.get(approval.id);
    if (!set) return;
    this.waiters.delete(approval.id);
    for (const w of set) w(approval);
  }

  /**
   * Tunggu keputusan sampai `timeoutMs`. Mengembalikan approval apa adanya
   * saat timeout (status masih "pending") — caller yang memutuskan artinya.
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
        // why: kembalikan state terkini, bukan error — SDK memutuskan sendiri
        // apakah mau menunggu lagi atau jatuh ke fail mode.
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
