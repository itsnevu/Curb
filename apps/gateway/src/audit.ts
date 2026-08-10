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
  /** A context summary — NEVER contains raw prompts. */
  contextDigest?: string;
}

export interface AuditSink {
  emit(event: AuditEvent): void;
}

/** No-op sink for tests and standalone mode. */
export const NULL_SINK: AuditSink = { emit: () => {} };

/**
 * Sends events to the control plane without waiting (fire-and-forget), so audit
 * latency never lands on the user's request path. Failures are buffered and retried;
 * if the buffer fills, the oldest event is dropped and counted.
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
      // put the batch back so nothing is lost across a control-plane restart
      this.queue.unshift(...batch);
      this.schedule();
    }
  }

  pending(): number {
    return this.queue.length;
  }
}
