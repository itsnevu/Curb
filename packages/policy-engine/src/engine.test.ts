import { describe, it, expect } from "vitest";
import { evaluate } from "./engine.js";
import { emptyState } from "./state.js";
import type { Context, Policy } from "@curb/shared";

const P = (over: Partial<Policy>): Policy => ({
  id: "p", name: "p", type: "cost_cap", scope: {}, params: {}, action: "deny", enabled: true, ...over,
});
const ctx = (over: Partial<Context> = {}): Context => ({ kind: "llm_call", runId: "r1", ...over });
const state = (over: Partial<ReturnType<typeof emptyState>> = {}) => ({ ...emptyState("r1", 0), ...over });

describe("cost_cap", () => {
  const p = P({ type: "cost_cap", params: { maxUsd: 2 } });
  it("DENY saat cost >= maxUsd", () => {
    expect(evaluate(ctx(), [p], state({ costUsd: 2.5 })).effect).toBe("DENY");
  });
  it("DENY tepat di batas", () => {
    expect(evaluate(ctx(), [p], state({ costUsd: 2 })).effect).toBe("DENY");
  });
  it("ALLOW saat masih di bawah", () => {
    expect(evaluate(ctx(), [p], state({ costUsd: 1.999 })).effect).toBe("ALLOW");
  });
});

describe("loop_detect", () => {
  const p = P({ type: "loop_detect", params: { maxRepeats: 3 } });
  it("DENY saat signature identik berulang", () => {
    expect(evaluate(ctx(), [p], state({ sigWindow: ["a", "a", "a"] })).effect).toBe("DENY");
  });
  it("ALLOW saat baru 2 kali", () => {
    expect(evaluate(ctx(), [p], state({ sigWindow: ["a", "b", "a"] })).effect).toBe("ALLOW");
  });
  it("DENY saat siklus tool A,B,A,B,A,B", () => {
    expect(evaluate(ctx(), [p], state({ toolWindow: ["A", "B", "A", "B", "A", "B"] })).effect).toBe("DENY");
  });
  it("ALLOW untuk urutan tool yang bervariasi", () => {
    expect(evaluate(ctx(), [p], state({ toolWindow: ["A", "B", "C", "D", "E", "F"] })).effect).toBe("ALLOW");
  });
  it("hanya melihat signatureWindow call terakhir", () => {
    // 3x "a" tapi tersebar di luar window 4 terakhir → bukan loop
    const s = state({ sigWindow: ["a", "a", "x", "y", "z", "a"] });
    const scoped = P({ type: "loop_detect", params: { maxRepeats: 3, signatureWindow: 4 } });
    expect(evaluate(ctx(), [scoped], s).effect).toBe("ALLOW");
  });
});

describe("step_limit", () => {
  const p = P({ type: "step_limit", params: { maxSteps: 5 } });
  // stepCount sudah termasuk step yang sedang dievaluasi
  it("ALLOW pada step ke-maxSteps", () => {
    expect(evaluate(ctx({ kind: "step" }), [p], state({ stepCount: 5 })).effect).toBe("ALLOW");
  });
  it("DENY pada step berikutnya", () => {
    expect(evaluate(ctx({ kind: "step" }), [p], state({ stepCount: 6 })).effect).toBe("DENY");
  });
});

describe("rate_limit", () => {
  const p = P({ type: "rate_limit", action: "throttle", params: { maxCalls: 3, perMs: 1000 } });
  it("THROTTLE saat call ke-4 dalam window", () => {
    const s = state({ callTimestamps: [100, 200, 300, 400] });
    const d = evaluate(ctx({ now: 500 }), [p], s);
    expect(d.effect).toBe("THROTTLE");
    expect(d.retryAfterMs).toBe(1000);
  });
  it("ALLOW saat masih 3 call", () => {
    expect(evaluate(ctx({ now: 500 }), [p], state({ callTimestamps: [100, 200, 300] })).effect).toBe("ALLOW");
  });
  it("ALLOW saat call lama sudah keluar window", () => {
    const s = state({ callTimestamps: [1, 2, 3, 5000] });
    expect(evaluate(ctx({ now: 5000 }), [p], s).effect).toBe("ALLOW");
  });
});

describe("time_limit", () => {
  const p = P({ type: "time_limit", params: { maxWallClockMs: 10_000 } });
  it("DENY saat run lebih tua dari batas", () => {
    expect(evaluate(ctx({ now: 10_001 }), [p], state({ startedAt: 0 })).effect).toBe("DENY");
  });
  it("ALLOW saat masih muda", () => {
    expect(evaluate(ctx({ now: 9_999 }), [p], state({ startedAt: 0 })).effect).toBe("ALLOW");
  });
});

describe("tool_permission", () => {
  it("ASK untuk tool yang cocok nama", () => {
    const p = P({ type: "tool_permission", action: "ask", params: { tools: ["delete_file"], mode: "ask" } });
    expect(evaluate(ctx({ kind: "tool_call", toolName: "delete_file" }), [p], state()).effect).toBe("ASK");
  });
  it("DENY saat mode deny", () => {
    const p = P({ type: "tool_permission", params: { tools: ["wipe_db"], mode: "deny" } });
    expect(evaluate(ctx({ kind: "tool_call", toolName: "wipe_db" }), [p], state()).effect).toBe("DENY");
  });
  it("ASK berdasarkan sensitivity, bukan nama", () => {
    const p = P({ type: "tool_permission", params: { sensitivity: "high", mode: "ask" } });
    expect(evaluate(ctx({ kind: "tool_call", toolName: "apa_saja", sensitivity: "high" }), [p], state()).effect).toBe("ASK");
  });
  it("ALLOW untuk tool yang tidak cocok", () => {
    const p = P({ type: "tool_permission", params: { tools: ["delete_file"], mode: "deny" } });
    expect(evaluate(ctx({ kind: "tool_call", toolName: "read_file" }), [p], state()).effect).toBe("ALLOW");
  });
  it("tidak berlaku untuk llm_call", () => {
    const p = P({ type: "tool_permission", params: { tools: ["delete_file"], mode: "deny" } });
    expect(evaluate(ctx({ kind: "llm_call", toolName: "delete_file" }), [p], state()).effect).toBe("ALLOW");
  });
});

describe("scope & when", () => {
  it("policy di luar scope project diabaikan", () => {
    const p = P({ type: "cost_cap", scope: { project: "lain" }, params: { maxUsd: 0 } });
    expect(evaluate(ctx({ projectId: "punyaku" }), [p], state({ costUsd: 99 })).effect).toBe("ALLOW");
  });
  it("policy dalam scope project berlaku", () => {
    const p = P({ type: "cost_cap", scope: { project: "punyaku" }, params: { maxUsd: 1 } });
    expect(evaluate(ctx({ projectId: "punyaku" }), [p], state({ costUsd: 99 })).effect).toBe("DENY");
  });
  it("when yang tidak cocok diabaikan", () => {
    const p = P({ type: "cost_cap", when: { env: "prod" }, params: { maxUsd: 0 } });
    expect(evaluate(ctx({ env: "dev" }), [p], state({ costUsd: 99 })).effect).toBe("ALLOW");
  });
  it("when yang cocok berlaku", () => {
    const p = P({ type: "cost_cap", when: { env: "prod" }, params: { maxUsd: 0 } });
    expect(evaluate(ctx({ env: "prod" }), [p], state({ costUsd: 99 })).effect).toBe("DENY");
  });
  it("policy disabled diabaikan", () => {
    const p = P({ type: "cost_cap", enabled: false, params: { maxUsd: 0 } });
    expect(evaluate(ctx(), [p], state({ costUsd: 99 })).effect).toBe("ALLOW");
  });
  it("tanpa policy sama sekali → ALLOW", () => {
    expect(evaluate(ctx(), [], state({ costUsd: 99 })).effect).toBe("ALLOW");
  });
});

describe("keputusan paling ketat menang", () => {
  const cost = P({ id: "a", type: "cost_cap", params: { maxUsd: 2 } });
  const ask = P({ id: "b", type: "tool_permission", params: { tools: ["x"], mode: "ask" } });
  const throttle = P({ id: "c", type: "rate_limit", params: { maxCalls: 0, perMs: 1000 } });
  const c = ctx({ kind: "tool_call", toolName: "x", now: 10 });

  it("DENY > ASK", () => {
    const d = evaluate(c, [ask, cost], state({ costUsd: 5 }));
    expect(d.effect).toBe("DENY");
    expect(d.policyId).toBe("a");
  });
  it("ASK > THROTTLE", () => {
    const d = evaluate(c, [throttle, ask], state({ callTimestamps: [5] }));
    expect(d.effect).toBe("ASK");
    expect(d.policyId).toBe("b");
  });
  it("THROTTLE > ALLOW", () => {
    expect(evaluate(c, [throttle], state({ callTimestamps: [5] })).effect).toBe("THROTTLE");
  });
  it("urutan policy tidak mempengaruhi hasil", () => {
    const s = () => state({ costUsd: 5, callTimestamps: [5] });
    expect(evaluate(c, [cost, ask, throttle], s()).effect).toBe("DENY");
    expect(evaluate(c, [throttle, ask, cost], s()).effect).toBe("DENY");
  });
});
