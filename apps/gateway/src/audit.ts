import { request } from "undici";
import type { Context, Decision } from "@curb/shared";

export interface AuditEvent {
  runId: string;
  projectId?: string;
  ts: number;
  kind: Context["kind"];
  effect: Decision["effect"];
  policyId?: string;
  reason?: string;
  model?: string;
  costUsdSnapshot: number;
  tokensSnapshot: number;
  /** Ringkasan konteks — TIDAK pernah berisi prompt mentah. */
  contextDigest?: string;
}

export interface AuditSink {
  emit(event: AuditEvent): void;
}

/** Sink no-op untuk test/standalone. */
export const NULL_SINK: AuditSink = { emit: () => {} };

/**
 * Kirim event ke control-plane tanpa menunggu (fire-and-forget) supaya
 * latensi audit tidak menempel di jalur permintaan user. Kegagalan di-buffer
 * lalu di-flush; kalau buffer penuh, event tertua dibuang dan dihitung.
 */
export class HttpAuditSink implements AuditSink {
  private queue: AuditEvent[] = [];
  private dropped = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private url: string,
    private opts: { apiKey?: string; maxQueue?: number; flushMs?: number; onError?: (e: unknown) => void } = {},
  ) {}

  emit(event: AuditEvent): void {
    const max = this.opts.maxQueue ?? 1000;
    if (this.queue.length >= max) {
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push(event);
    this.schedule();
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.opts.flushMs ?? 250);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await request(`${this.url.replace(/\/$/, "")}/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-curb-key": this.opts.apiKey ?? "" },
        body: JSON.stringify({ events: batch, dropped: this.dropped }),
        headersTimeout: 3_000,
        bodyTimeout: 3_000,
      });
      this.dropped = 0;
    } catch (err) {
      this.opts.onError?.(err);
      // kembalikan ke antrian supaya tidak hilang saat control-plane restart
      this.queue.unshift(...batch);
      this.schedule();
    }
  }

  pending(): number {
    return this.queue.length;
  }
}
