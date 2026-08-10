import type { Approval, EventRecord } from "./repo/types.js";

export interface Notifier {
  policyTripped(event: EventRecord): void;
  approvalRequested(approval: Approval, dashboardUrl?: string): void;
}

export const NULL_NOTIFIER: Notifier = { policyTripped: () => {}, approvalRequested: () => {} };

export interface NotifyOptions {
  webhookUrl?: string;
  slackWebhookUrl?: string;
  dashboardUrl?: string;
  fetch?: typeof fetch;
  onError?: (err: unknown) => void;
  /** Suppress repeats of the same event within this window. */
  dedupeMs?: number;
  now?: () => number;
}

/**
 * Sends alerts when a breaker trips or something is waiting for approval.
 * Always fire-and-forget: a failed alert must never fail a policy decision.
 */
export class HttpNotifier implements Notifier {
  private lastSent = new Map<string, number>();

  constructor(private opts: NotifyOptions = {}) {}

  policyTripped(event: EventRecord): void {
    if (event.effect !== "DENY" && event.effect !== "THROTTLE") return;
    // why: one stuck run can produce hundreds of DENYs — don't flood Slack.
    if (!this.allow(`${event.runId}:${event.policyId}`)) return;

    const title = event.effect === "DENY" ? "🛑 Curb blocked a run" : "🐢 Curb throttled a run";
    this.send(
      { type: "policy_tripped", ...event },
      `${title}\n*run:* \`${event.runId}\`\n*policy:* \`${event.policyId ?? "?"}\`\n*reason:* ${event.reason ?? "-"}`,
    );
  }

  approvalRequested(approval: Approval, dashboardUrl = this.opts.dashboardUrl): void {
    if (!this.allow(`apr:${approval.id}`)) return;
    const link = dashboardUrl ? `\n<${dashboardUrl}|Open the dashboard to decide>` : "";
    this.send(
      { type: "approval_requested", ...approval, dashboardUrl },
      `✋ *${approval.toolName}* is waiting for approval\n*run:* \`${approval.runId}\`\n*reason:* ${approval.reason ?? "-"}${link}`,
    );
  }

  private allow(key: string): boolean {
    const window = this.opts.dedupeMs ?? 60_000;
    const now = (this.opts.now ?? Date.now)();
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < window) return false;
    this.lastSent.set(key, now);
    return true;
  }

  private send(payload: Record<string, unknown>, slackText: string): void {
    const doFetch = this.opts.fetch ?? fetch;
    const post = (url: string, body: unknown) =>
      doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).catch((err) => this.opts.onError?.(err));

    if (this.opts.webhookUrl) void post(this.opts.webhookUrl, payload);
    if (this.opts.slackWebhookUrl) void post(this.opts.slackWebhookUrl, { text: slackText });
  }
}

export function notifierFromEnv(opts: Partial<NotifyOptions> = {}): Notifier {
  const webhookUrl = process.env.CURB_WEBHOOK_URL;
  const slackWebhookUrl = process.env.CURB_SLACK_WEBHOOK_URL;
  if (!webhookUrl && !slackWebhookUrl) return NULL_NOTIFIER;
  return new HttpNotifier({
    webhookUrl,
    slackWebhookUrl,
    dashboardUrl: process.env.CURB_DASHBOARD_URL,
    ...opts,
  });
}
