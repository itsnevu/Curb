import { describe, it, expect, beforeEach } from "vitest";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { InMemoryRunStateStore } from "@curb/policy-engine";
import type { Policy } from "@curb/shared";
import { buildApp, type UpstreamResponse } from "./app.js";
import { PriceTable } from "./pricing.js";
import type { AuditEvent, AuditSink } from "./audit.js";

const P = (over: Partial<Policy>): Policy => ({
  id: "p", name: "p", type: "cost_cap", scope: {}, params: {}, action: "deny", enabled: true, ...over,
});

/** 1000 token in + 1000 token out @ $1/$1 per Mtok = $0.002 per call. */
const PRICES = new PriceTable({ "fake-model": { in: 1, out: 1 }, default: { in: 1, out: 1 } });

function makeUpstream(usage = { prompt_tokens: 1000, completion_tokens: 1000 }) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const forward = async (url: string, headers: Record<string, string>, body: unknown): Promise<UpstreamResponse> => {
    calls.push({ url, headers, body });
    return { status: 200, headers: { "content-type": "application/json" }, json: { id: "x", usage } };
  };
  return { calls, forward };
}

interface Harness {
  app: FastifyInstance;
  events: AuditEvent[];
  calls: Array<{ url: string; headers: Record<string, string>; body: unknown }>;
}

function harness(policies: Policy[], over: Partial<Parameters<typeof buildApp>[0]> = {}): Harness {
  const events: AuditEvent[] = [];
  const audit: AuditSink = { emit: (e) => events.push(e) };
  const up = makeUpstream();
  const app = buildApp({
    store: new InMemoryRunStateStore(() => 0),
    loadPolicies: async () => policies,
    forward: up.forward,
    audit,
    prices: PRICES,
    now: () => 1_000,
    ...over,
  });
  return { app, events, calls: up.calls };
}

const post = (app: FastifyInstance, runId: string, body: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "x-curb-run-id": runId, authorization: "Bearer sk-rahasia", "content-type": "application/json" },
    payload: { model: "fake-model", messages: [{ role: "user", content: "halo" }], ...body },
  });

describe("gateway — dasar", () => {
  it("health OK", async () => {
    const { app } = harness([]);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("meneruskan call ketika tidak ada policy", async () => {
    const { app, calls } = harness([]);
    const res = await post(app, "r1");
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(res.headers["x-curb-run-id"]).toBe("r1");
  });

  it("membuang header Curb sebelum meneruskan ke provider", async () => {
    const { app, calls } = harness([]);
    await post(app, "r1");
    const sent = calls[0].headers;
    expect(sent["x-curb-run-id"]).toBeUndefined();
    expect(sent["x-curb-key"]).toBeUndefined();
    expect(sent["authorization"]).toBe("Bearer sk-rahasia"); // kredensial user tetap lewat
  });

  it("membuat run id sendiri kalau klien tidak mengirim", async () => {
    const { app } = harness([]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "fake-model", messages: [] },
    });
    expect(res.headers["x-curb-run-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("gateway — cost_cap (acceptance M1)", () => {
  let h: Harness;
  beforeEach(() => {
    // $0.002/call, batas $0.005 → call 1,2 lewat; setelah itu cost 0.006 >= 0.005 → DENY
    h = harness([P({ id: "cc", type: "cost_cap", params: { maxUsd: 0.005 } })]);
  });

  it("biaya menumpuk lintas call lalu call ke-(N+1) ditolak", async () => {
    expect((await post(h.app, "r1")).statusCode).toBe(200);
    expect((await post(h.app, "r1")).statusCode).toBe(200);
    expect((await post(h.app, "r1")).statusCode).toBe(200);
    const blocked = await post(h.app, "r1");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["x-curb-policy"]).toBe("cc");
    expect(h.calls).toHaveLength(3); // call ke-4 tidak pernah sampai provider
  });

  it("run lain tidak ikut kena", async () => {
    for (let i = 0; i < 4; i++) await post(h.app, "r1");
    expect((await post(h.app, "r2")).statusCode).toBe(200);
  });

  it("error body berbentuk OpenAI supaya SDK klien mengenalinya", async () => {
    for (let i = 0; i < 3; i++) await post(h.app, "r1");
    const body = (await post(h.app, "r1")).json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe("curb_policy_violation");
    expect(body.error.message).toContain("Curb policy");
  });

  it("error body berbentuk Anthropic di endpoint /v1/messages", async () => {
    const app = harness([P({ id: "cc", type: "cost_cap", params: { maxUsd: 0 } })]).app;
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-curb-run-id": "ra" },
      payload: { model: "fake-model", messages: [] },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ type: "error", error: { type: "rate_limit_error" } });
  });
});

describe("gateway — loop_detect (acceptance M1)", () => {
  it("pesan identik berulang maxRepeats kali ditolak", async () => {
    const h = harness([P({ id: "ld", type: "loop_detect", params: { maxRepeats: 3 } })]);
    expect((await post(h.app, "r1")).statusCode).toBe(200);
    expect((await post(h.app, "r1")).statusCode).toBe(200);
    const third = await post(h.app, "r1");
    expect(third.statusCode).toBe(429);
    expect((third.json() as { curb: { policyId: string } }).curb.policyId).toBe("ld");
  });

  it("pesan yang berubah tiap call tidak dianggap loop", async () => {
    const h = harness([P({ id: "ld", type: "loop_detect", params: { maxRepeats: 3 } })]);
    for (let i = 0; i < 5; i++) {
      const res = await post(h.app, "r1", { messages: [{ role: "user", content: `pesan ${i}` }] });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe("gateway — streaming", () => {
  const sse = [
    'data: {"id":"1","choices":[{"delta":{"content":"ha"}}]}\n\n',
    'data: {"id":"1","choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"id":"1","usage":{"prompt_tokens":1000,"completion_tokens":1000}}\n\n',
    "data: [DONE]\n\n",
  ];

  function streamHarness(policies: Policy[]) {
    const store = new InMemoryRunStateStore(() => 0);
    const app = buildApp({
      store,
      loadPolicies: async () => policies,
      forward: async (_u, _h, _b, streaming) => ({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        stream: streaming ? Readable.from(sse) : undefined,
        json: streaming ? undefined : { usage: {} },
      }),
      prices: PRICES,
      now: () => 1_000,
    });
    return { app, store };
  }

  it("meneruskan SSE apa adanya", async () => {
    const { app } = streamHarness([]);
    const res = await post(app, "r1", { stream: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain('"delta"');
    expect(res.body).toContain("[DONE]");
  });

  it("menghitung usage dari chunk terakhir stream", async () => {
    const { app, store } = streamHarness([]);
    await post(app, "r1", { stream: true });
    await new Promise((r) => setImmediate(r)); // settle() jalan setelah stream end
    const s = await store.get("r1");
    expect(s.tokens).toBe(2000);
    expect(s.costUsd).toBeCloseTo(0.002, 6);
  });

  it("breaker tetap menahan SEBELUM stream dibuka", async () => {
    const { app } = streamHarness([P({ id: "cc", type: "cost_cap", params: { maxUsd: 0 } })]);
    const res = await post(app, "r1", { stream: true });
    expect(res.statusCode).toBe(429);
  });
});

describe("gateway — fail mode & audit", () => {
  const boom = async (): Promise<Policy[]> => {
    throw new Error("control-plane mati");
  };

  it("fail-closed: policy tidak bisa dimuat → DENY", async () => {
    const { app } = harness([], { loadPolicies: boom, failMode: "closed" });
    const res = await post(app, "r1");
    expect(res.statusCode).toBe(429);
    expect(res.headers["x-curb-policy"]).toBe("curb_fail_closed");
  });

  it("fail-open: policy tidak bisa dimuat → tetap lewat", async () => {
    const { app } = harness([], { loadPolicies: boom, failMode: "open" });
    expect((await post(app, "r1")).statusCode).toBe(200);
  });

  it("setiap keputusan menghasilkan audit event", async () => {
    const h = harness([P({ id: "cc", type: "cost_cap", params: { maxUsd: 0.003 } })]);
    await post(h.app, "r1");
    await post(h.app, "r1");
    await post(h.app, "r1");
    expect(h.events.map((e) => e.effect)).toEqual(["ALLOW", "ALLOW", "DENY"]);
    const denied = h.events.at(-1)!;
    expect(denied).toMatchObject({ runId: "r1", policyId: "cc", kind: "llm_call", model: "fake-model" });
    expect(denied.costUsdSnapshot).toBeCloseTo(0.004, 6);
  });

  it("audit event tidak pernah memuat prompt mentah", async () => {
    const h = harness([]);
    await post(h.app, "r1", { messages: [{ role: "user", content: "NOMOR-KARTU-4111" }] });
    expect(JSON.stringify(h.events)).not.toContain("NOMOR-KARTU");
  });
});

describe("gateway — throttle", () => {
  it("menahan sebentar lalu tetap meneruskan", async () => {
    const h = harness([P({ id: "rl", type: "rate_limit", action: "throttle", params: { maxCalls: 1, perMs: 10 } })]);
    expect((await post(h.app, "r1")).statusCode).toBe(200);
    const second = await post(h.app, "r1");
    expect(second.statusCode).toBe(200);
    expect(h.events.map((e) => e.effect)).toContain("THROTTLE");
  });

  it("menolak dengan retry-after kalau tunggunya kelamaan", async () => {
    const h = harness([P({ id: "rl", type: "rate_limit", action: "throttle", params: { maxCalls: 1, perMs: 60_000 } })], {
      maxThrottleMs: 100,
    });
    await post(h.app, "r1");
    const second = await post(h.app, "r1");
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBe("60");
  });
});
