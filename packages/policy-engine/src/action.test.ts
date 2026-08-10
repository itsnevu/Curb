import { describe, it, expect } from "vitest";
import { evaluate } from "./engine.js";
import { emptyState } from "./state.js";
import { costWindowKeys, runKey } from "./keys.js";
import type { Context, Policy } from "@curb/shared";

const P = (over: Partial<Policy>): Policy => ({
  id: "p", name: "p", type: "cost_cap", scope: {}, params: {}, action: "deny", enabled: true, ...over,
});
const ctx = (over: Partial<Context> = {}): Context => ({ kind: "llm_call", runId: "r1", ...over });
const state = (over: Partial<ReturnType<typeof emptyState>> = {}) => ({ ...emptyState("r1", 0), ...over });

/**
 * The division of labour: an evaluator decides WHETHER its rule is broken,
 * `policy.action` decides WHAT HAPPENS. Before this existed, `action` was stored,
 * documented and completely ignored — every trip was a DENY.
 */
describe("policy.action decides the effect", () => {
  const broken = state({ costUsd: 99 });
  const cap = (action: Policy["action"]) => P({ type: "cost_cap", action, params: { maxUsd: 1 } });

  it("the same broken rule denies, asks or throttles depending on action", () => {
    expect(evaluate(ctx(), [cap("deny")], broken).effect).toBe("DENY");
    expect(evaluate(ctx(), [cap("ask")], broken).effect).toBe("ASK");
    expect(evaluate(ctx(), [cap("throttle")], broken).effect).toBe("THROTTLE");
  });

  it("action 'allow' turns a tripped rule into an audit-only signal", () => {
    expect(evaluate(ctx(), [cap("allow")], broken).effect).toBe("ALLOW");
  });

  it("a rule that is NOT broken stays ALLOW whatever the action says", () => {
    expect(evaluate(ctx(), [cap("deny")], state({ costUsd: 0 })).effect).toBe("ALLOW");
  });

  it("the reason still comes from the evaluator, so operators see why", () => {
    const d = evaluate(ctx(), [cap("throttle")], broken);
    expect(d.reason).toContain("cost_cap");
    expect(d.policyId).toBe("p");
  });

  it("retryAfterMs is dropped when the action is not a throttle", () => {
    const rl = (action: Policy["action"]) =>
      P({ type: "rate_limit", action, params: { maxCalls: 0, perMs: 5_000 } });
    const s = state({ callTimestamps: [1] });
    expect(evaluate(ctx({ now: 2 }), [rl("throttle")], s).retryAfterMs).toBe(5_000);
    expect(evaluate(ctx({ now: 2 }), [rl("deny")], s).retryAfterMs).toBeUndefined();
  });

  it("`final` never leaks out of the engine", () => {
    const p = P({ type: "tool_permission", action: "deny", params: { tools: ["x"], mode: "ask" } });
    const d = evaluate(ctx({ kind: "tool_call", toolName: "x" }), [p], state());
    expect(d).not.toHaveProperty("final");
  });
});

describe("tool_permission mode overrides the action", () => {
  const c = ctx({ kind: "tool_call", toolName: "delete_file" });
  const tp = (params: Record<string, unknown>, action: Policy["action"] = "deny") =>
    P({ type: "tool_permission", action, params: { tools: ["delete_file"], ...params } });

  it("an explicit mode wins over action", () => {
    // why: mode is the older, per-policy escape hatch; it must keep working exactly.
    expect(evaluate(c, [tp({ mode: "ask" }, "deny")], state()).effect).toBe("ASK");
    expect(evaluate(c, [tp({ mode: "deny" }, "ask")], state()).effect).toBe("DENY");
    expect(evaluate(c, [tp({ mode: "allow" }, "deny")], state()).effect).toBe("ALLOW");
  });

  it("without a mode, the action decides", () => {
    expect(evaluate(c, [tp({}, "ask")], state()).effect).toBe("ASK");
    expect(evaluate(c, [tp({}, "deny")], state()).effect).toBe("DENY");
  });
});

describe("cost_cap windows", () => {
  const cap = (window: string) => P({ type: "cost_cap", params: { maxUsd: 5, window, preflight: false } });

  it("window 'run' reads the run's own spend", () => {
    expect(evaluate(ctx(), [cap("run")], state({ costUsd: 6 })).effect).toBe("DENY");
    expect(evaluate(ctx({ costWindows: { hour: 99 } }), [cap("run")], state({ costUsd: 1 })).effect).toBe("ALLOW");
  });

  it("window 'hour' reads the hourly bucket, not the run", () => {
    const s = state({ costUsd: 0 });
    expect(evaluate(ctx({ costWindows: { hour: 6 } }), [cap("hour")], s).effect).toBe("DENY");
    expect(evaluate(ctx({ costWindows: { hour: 1 } }), [cap("hour")], s).effect).toBe("ALLOW");
  });

  it("window 'day' reads the daily bucket", () => {
    const s = state({ costUsd: 0 });
    expect(evaluate(ctx({ costWindows: { day: 6 } }), [cap("day")], s).effect).toBe("DENY");
    expect(evaluate(ctx({ costWindows: { day: 1 } }), [cap("day")], s).effect).toBe("ALLOW");
  });

  it("a fresh run is still stopped by an exhausted hourly budget", () => {
    // the whole point of a wider window: a new run must not reset the budget
    const d = evaluate(ctx({ costWindows: { hour: 10 } }), [cap("hour")], state({ costUsd: 0 }));
    expect(d.effect).toBe("DENY");
    expect(d.reason).toContain("last hour");
  });
});

describe("cost_cap preflight", () => {
  const cap = P({ type: "cost_cap", params: { maxUsd: 1, preflight: true } });

  it("holds a call whose estimate alone would break the cap", () => {
    const d = evaluate(ctx({ estimatedCostUsd: 0.8 }), [cap], state({ costUsd: 0.5 }));
    expect(d.effect).toBe("DENY");
    expect(d.reason).toContain("estimated");
  });

  it("allows a call that fits inside what is left", () => {
    expect(evaluate(ctx({ estimatedCostUsd: 0.4 }), [cap], state({ costUsd: 0.5 })).effect).toBe("ALLOW");
  });

  it("without an estimate it falls back to spend-only accounting", () => {
    expect(evaluate(ctx(), [cap], state({ costUsd: 0.9 })).effect).toBe("ALLOW");
  });

  it("preflight: false ignores the estimate entirely", () => {
    const off = P({ type: "cost_cap", params: { maxUsd: 1, preflight: false } });
    expect(evaluate(ctx({ estimatedCostUsd: 99 }), [off], state({ costUsd: 0.5 })).effect).toBe("ALLOW");
  });
});

describe("multi-tenant key isolation", () => {
  it("the same run id in two projects gets two different state keys", () => {
    // why: run ids come from the client. Sharing a key across tenants means one
    // project can read — or exhaust — another project's cost counter.
    expect(runKey("proj-a", "run-1")).not.toBe(runKey("proj-b", "run-1"));
  });

  it("a missing project cannot collide with a real one named '_'", () => {
    expect(runKey(undefined, "run-1")).toBe(runKey(undefined, "run-1"));
    expect(runKey(undefined, "run-1")).not.toBe(runKey("proj-a", "run-1"));
  });

  it("cost buckets are per project and per period", () => {
    const t = 1_700_000_000_000;
    const a = costWindowKeys("proj-a", t);
    const b = costWindowKeys("proj-b", t);
    expect(a.hour.bucket).not.toBe(b.hour.bucket);
    expect(a.hour.bucket).not.toBe(a.day.bucket);
  });

  it("buckets roll over with time, and outlive their window", () => {
    const t = 1_700_000_000_000;
    const HOUR = 3_600_000;
    expect(costWindowKeys("p", t).hour.bucket).not.toBe(costWindowKeys("p", t + HOUR).hour.bucket);
    expect(costWindowKeys("p", t).hour.bucket).toBe(costWindowKeys("p", t + 60_000).hour.bucket);
    // a bucket must survive longer than its own window, or a call landing on the
    // boundary would see an empty budget
    expect(costWindowKeys("p", t).hour.ttlSeconds).toBeGreaterThan(3600);
    expect(costWindowKeys("p", t).day.ttlSeconds).toBeGreaterThan(86_400);
  });
});
