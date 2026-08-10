import { describe, it, expect } from "vitest";
import { HttpNotifier } from "./notify.js";
import type { Approval, EventRecord } from "./repo/types.js";

function spy() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return { ok: true } as Response;
  }) as unknown as typeof fetch;
  return { calls, doFetch };
}

const event = (over: Partial<EventRecord> = {}): EventRecord => ({
  runId: "r1", ts: 1000, kind: "llm_call", effect: "DENY", policyId: "cc", reason: "cost cap", ...over,
});

const approval: Approval = {
  id: "apr_1", runId: "r1", toolName: "delete_file", status: "pending",
  requestedAt: 1000, reason: "butuh persetujuan",
};

describe("HttpNotifier", () => {
  it("mengirim ke webhook dan Slack saat breaker nyala", async () => {
    const s = spy();
    new HttpNotifier({ webhookUrl: "http://wh", slackWebhookUrl: "http://slack", fetch: s.doFetch })
      .policyTripped(event());
    await new Promise((r) => setImmediate(r));

    expect(s.calls.map((c) => c.url)).toEqual(["http://wh", "http://slack"]);
    expect(s.calls[0].body).toMatchObject({ type: "policy_tripped", runId: "r1", policyId: "cc" });
    expect(String(s.calls[1].body.text)).toContain("blocked");
  });

  it("event ALLOW tidak memicu alert", async () => {
    const s = spy();
    new HttpNotifier({ webhookUrl: "http://wh", fetch: s.doFetch }).policyTripped(event({ effect: "ALLOW" }));
    await new Promise((r) => setImmediate(r));
    expect(s.calls).toHaveLength(0);
  });

  it("DENY berulang pada run+policy yang sama hanya dikirim sekali per jendela", async () => {
    const s = spy();
    let t = 0;
    const n = new HttpNotifier({ webhookUrl: "http://wh", fetch: s.doFetch, dedupeMs: 1000, now: () => t });
    n.policyTripped(event());
    n.policyTripped(event());
    t = 1500;
    n.policyTripped(event());
    await new Promise((r) => setImmediate(r));
    expect(s.calls).toHaveLength(2);
  });

  it("policy berbeda tetap dikirim terpisah", async () => {
    const s = spy();
    const n = new HttpNotifier({ webhookUrl: "http://wh", fetch: s.doFetch, now: () => 0 });
    n.policyTripped(event({ policyId: "cc" }));
    n.policyTripped(event({ policyId: "loop" }));
    await new Promise((r) => setImmediate(r));
    expect(s.calls).toHaveLength(2);
  });

  it("approval memuat tautan dashboard", async () => {
    const s = spy();
    new HttpNotifier({ slackWebhookUrl: "http://slack", dashboardUrl: "http://dash", fetch: s.doFetch })
      .approvalRequested(approval);
    await new Promise((r) => setImmediate(r));
    const text = String(s.calls[0].body.text);
    expect(text).toContain("delete_file");
    expect(text).toContain("http://dash");
  });

  it("alert yang gagal tidak melempar ke pemanggil", async () => {
    const failing = (async () => {
      throw new Error("slack mati");
    }) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const n = new HttpNotifier({ webhookUrl: "http://wh", fetch: failing, onError: (e) => errors.push(e) });
    expect(() => n.policyTripped(event())).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(errors).toHaveLength(1);
  });

  it("tanpa URL yang dikonfigurasi tidak ada request sama sekali", async () => {
    const s = spy();
    new HttpNotifier({ fetch: s.doFetch }).policyTripped(event());
    await new Promise((r) => setImmediate(r));
    expect(s.calls).toHaveLength(0);
  });
});
