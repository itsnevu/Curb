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
  it("DENY once cost >= maxUsd", () => {
    expect(evaluate(ctx(), [p], state({ costUsd: 2.5 })).effect).toBe("DENY");
  });
  it("DENY exactly at the limit", () => {
    expect(evaluate(ctx(), [p], state({ costUsd: 2 })).effect).toBe("DENY");
  });
  it("ALLOW while still under", () => {
    expect(evaluate(ctx(), [p], state({ costUsd: 1.999 })).effect).toBe("ALLOW");
  });
});

describe("loop_detect", () => {
  const p = P({ type: "loop_detect", params: { maxRepeats: 3 } });
  it("DENY on repeated identical signatures", () => {
    expect(evaluate(ctx(), [p], state({ sigWindow: ["a", "a", "a"] })).effect).toBe("DENY");
  });
  it("ALLOW after only 2 repeats", () => {
    expect(evaluate(ctx(), [p], state({ sigWindow: ["a", "b", "a"] })).effect).toBe("ALLOW");
  });
  it("DENY on the tool cycle A,B,A,B,A,B", () => {
    expect(evaluate(ctx(), [p], state({ toolWindow: ["A", "B", "A", "B", "A", "B"] })).effect).toBe("DENY");
  });
  it("ALLOW for a varied tool sequence", () => {
    expect(evaluate(ctx(), [p], state({ toolWindow: ["A", "B", "C", "D", "E", "F"] })).effect).toBe("ALLOW");
  });
  it("only looks at the last signatureWindow calls", () => {
    // "a" appears 3x but spread outside the last 4 → not a loop
    const s = state({ sigWindow: ["a", "a", "x", "y", "z", "a"] });
    const scoped = P({ type: "loop_detect", params: { maxRepeats: 3, signatureWindow: 4 } });
    expect(evaluate(ctx(), [scoped], s).effect).toBe("ALLOW");
  });
});

describe("step_limit", () => {
  const p = P({ type: "step_limit", params: { maxSteps: 5 } });
  // stepCount already includes the step being evaluated
  it("ALLOW on step number maxSteps", () => {
    expect(evaluate(ctx({ kind: "step" }), [p], state({ stepCount: 5 })).effect).toBe("ALLOW");
  });
  it("DENY on the following step", () => {
    expect(evaluate(ctx({ kind: "step" }), [p], state({ stepCount: 6 })).effect).toBe("DENY");
  });
});

describe("rate_limit", () => {
  const p = P({ type: "rate_limit", action: "throttle", params: { maxCalls: 3, perMs: 1000 } });
  it("THROTTLE on the 4th call inside the window", () => {
    const s = state({ callTimestamps: [100, 200, 300, 400] });
    const d = evaluate(ctx({ now: 500 }), [p], s);
    expect(d.effect).toBe("THROTTLE");
    expect(d.retryAfterMs).toBe(1000);
  });
  it("ALLOW while still at 3 calls", () => {
    expect(evaluate(ctx({ now: 500 }), [p], state({ callTimestamps: [100, 200, 300] })).effect).toBe("ALLOW");
  });
  it("ALLOW once older calls fall out of the window", () => {
    const s = state({ callTimestamps: [1, 2, 3, 5000] });
    expect(evaluate(ctx({ now: 5000 }), [p], s).effect).toBe("ALLOW");
  });
});

describe("time_limit", () => {
  const p = P({ type: "time_limit", params: { maxWallClockMs: 10_000 } });
  it("DENY once the run is older than the limit", () => {
    expect(evaluate(ctx({ now: 10_001 }), [p], state({ startedAt: 0 })).effect).toBe("DENY");
  });
  it("ALLOW while the run is still young", () => {
    expect(evaluate(ctx({ now: 9_999 }), [p], state({ startedAt: 0 })).effect).toBe("ALLOW");
  });
});

describe("tool_permission", () => {
  it("ASK for a tool matched by name", () => {
    const p = P({ type: "tool_permission", action: "ask", params: { tools: ["delete_file"], mode: "ask" } });
    expect(evaluate(ctx({ kind: "tool_call", toolName: "delete_file" }), [p], state()).effect).toBe("ASK");
  });
  it("DENY when mode is deny", () => {
    const p = P({ type: "tool_permission", params: { tools: ["wipe_db"], mode: "deny" } });
    expect(evaluate(ctx({ kind: "tool_call", toolName: "wipe_db" }), [p], state()).effect).toBe("DENY");
  });
  it("ASK based on sensitivity rather than name", () => {
    const p = P({ type: "tool_permission", params: { sensitivity: "high", mode: "ask" } });
    expect(evaluate(ctx({ kind: "tool_call", toolName: "anything", sensitivity: "high" }), [p], state()).effect).toBe("ASK");
  });
  it("ALLOW for a tool that does not match", () => {
    const p = P({ type: "tool_permission", params: { tools: ["delete_file"], mode: "deny" } });
    expect(evaluate(ctx({ kind: "tool_call", toolName: "read_file" }), [p], state()).effect).toBe("ALLOW");
  });
  it("does not apply to llm_call", () => {
    const p = P({ type: "tool_permission", params: { tools: ["delete_file"], mode: "deny" } });
    expect(evaluate(ctx({ kind: "llm_call", toolName: "delete_file" }), [p], state()).effect).toBe("ALLOW");
  });
});

describe("scope & when", () => {
  it("a policy outside the project scope is ignored", () => {
    const p = P({ type: "cost_cap", scope: { project: "other" }, params: { maxUsd: 0 } });
    expect(evaluate(ctx({ projectId: "mine" }), [p], state({ costUsd: 99 })).effect).toBe("ALLOW");
  });
  it("a policy inside the project scope applies", () => {
    const p = P({ type: "cost_cap", scope: { project: "mine" }, params: { maxUsd: 1 } });
    expect(evaluate(ctx({ projectId: "mine" }), [p], state({ costUsd: 99 })).effect).toBe("DENY");
  });
  it("a non-matching `when` is ignored", () => {
    const p = P({ type: "cost_cap", when: { env: "prod" }, params: { maxUsd: 0 } });
    expect(evaluate(ctx({ env: "dev" }), [p], state({ costUsd: 99 })).effect).toBe("ALLOW");
  });
  it("a matching `when` applies", () => {
    const p = P({ type: "cost_cap", when: { env: "prod" }, params: { maxUsd: 0 } });
    expect(evaluate(ctx({ env: "prod" }), [p], state({ costUsd: 99 })).effect).toBe("DENY");
  });
  it("a disabled policy is ignored", () => {
    const p = P({ type: "cost_cap", enabled: false, params: { maxUsd: 0 } });
    expect(evaluate(ctx(), [p], state({ costUsd: 99 })).effect).toBe("ALLOW");
  });
  it("no policies at all → ALLOW", () => {
    expect(evaluate(ctx(), [], state({ costUsd: 99 })).effect).toBe("ALLOW");
  });
});

describe("strictest decision wins", () => {
  const cost = P({ id: "a", type: "cost_cap", params: { maxUsd: 2 } });
  const ask = P({ id: "b", type: "tool_permission", params: { tools: ["x"], mode: "ask" } });
  const throttle = P({ id: "c", type: "rate_limit", action: "throttle", params: { maxCalls: 0, perMs: 1000 } });
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
  it("policy order does not affect the outcome", () => {
    const s = () => state({ costUsd: 5, callTimestamps: [5] });
    expect(evaluate(c, [cost, ask, throttle], s()).effect).toBe("DENY");
    expect(evaluate(c, [throttle, ask, cost], s()).effect).toBe("DENY");
  });
});
