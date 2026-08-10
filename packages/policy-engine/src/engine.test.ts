import { describe, it, expect } from "vitest";
import { evaluate } from "./engine.js";
import { emptyState } from "./state.js";
import type { Context, Policy } from "@curb/shared";

const P = (over: Partial<Policy>): Policy => ({
  id: "p", name: "p", type: "cost_cap", scope: {}, params: {}, action: "deny", enabled: true, ...over,
});
const ctx = (over: Partial<Context> = {}): Context => ({ kind: "llm_call", runId: "r1", ...over });

describe("cost_cap", () => {
  it("DENY saat cost >= maxUsd", () => {
    const s = emptyState("r1", 0); s.costUsd = 2.5;
    const d = evaluate(ctx(), [P({ type: "cost_cap", params: { maxUsd: 2 } })], s);
    expect(d.effect).toBe("DENY");
  });
  it("ALLOW saat masih di bawah", () => {
    const s = emptyState("r1", 0); s.costUsd = 1;
    expect(evaluate(ctx(), [P({ type: "cost_cap", params: { maxUsd: 2 } })], s).effect).toBe("ALLOW");
  });
});

describe("loop_detect", () => {
  it("DENY saat signature identik berulang", () => {
    const s = emptyState("r1", 0); s.sigWindow = ["a", "a", "a"];
    const d = evaluate(ctx(), [P({ type: "loop_detect", params: { maxRepeats: 3 } })], s);
    expect(d.effect).toBe("DENY");
  });
  it("DENY saat siklus tool A,B,A,B,A,B", () => {
    const s = emptyState("r1", 0); s.toolWindow = ["A", "B", "A", "B", "A", "B"];
    const d = evaluate(ctx(), [P({ type: "loop_detect", params: { maxRepeats: 3 } })], s);
    expect(d.effect).toBe("DENY");
  });
});

describe("tool_permission", () => {
  it("ASK untuk tool sensitif", () => {
    const d = evaluate(
      ctx({ kind: "tool_call", toolName: "delete_file" }),
      [P({ type: "tool_permission", action: "ask", params: { tools: ["delete_file"], mode: "ask" } })],
      emptyState("r1", 0),
    );
    expect(d.effect).toBe("ASK");
  });
});

describe("keputusan paling ketat menang", () => {
  it("DENY > ASK", () => {
    const s = emptyState("r1", 0); s.costUsd = 5;
    const d = evaluate(
      ctx({ kind: "tool_call", toolName: "x" }),
      [
        P({ id: "a", type: "cost_cap", params: { maxUsd: 2 } }),
        P({ id: "b", type: "tool_permission", params: { tools: ["x"], mode: "ask" } }),
      ],
      s,
    );
    expect(d.effect).toBe("DENY");
  });
});
