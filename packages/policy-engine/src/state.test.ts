import { describe, it, expect, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import type { RunStateStore } from "@curb/shared";
import { InMemoryRunStateStore } from "./state.js";
import { RedisRunStateStore, type RedisLike } from "./redis-state.js";

/**
 * The store contract is tested twice: in-memory (dev) and Redis (production).
 * why: the two implementations MUST behave identically, otherwise policies quietly
 * change meaning the moment you move to production.
 */
const makers: Array<[string, () => RunStateStore]> = [
  ["InMemoryRunStateStore", () => new InMemoryRunStateStore(() => 1_000)],
  [
    "RedisRunStateStore",
    () =>
      new RedisRunStateStore(new RedisMock() as unknown as RedisLike, {
        now: () => 1_000,
      }),
  ],
];

describe.each(makers)("%s", (_name, make) => {
  let store: RunStateStore;
  beforeEach(async () => {
    store = make();
    await store.reset("r1");
  });

  it("a new run starts from zero", async () => {
    const s = await store.get("r1");
    expect(s.costUsd).toBe(0);
    expect(s.tokens).toBe(0);
    expect(s.stepCount).toBe(0);
    expect(s.sigWindow).toEqual([]);
  });

  it("bump accumulates counters", async () => {
    await store.bump("r1", { tokens: 100, costUsd: 0.25, steps: 1 });
    await store.bump("r1", { tokens: 50, costUsd: 0.5, steps: 1 });
    const s = await store.get("r1");
    expect(s.tokens).toBe(150);
    expect(s.costUsd).toBeCloseTo(0.75, 6);
    expect(s.stepCount).toBe(2);
  });

  it("concurrent bumps lose no updates (atomic)", async () => {
    await Promise.all(
      Array.from({ length: 20 }, () => store.bump("r1", { costUsd: 0.1, steps: 1 })),
    );
    const s = await store.get("r1");
    expect(s.costUsd).toBeCloseTo(2, 6);
    expect(s.stepCount).toBe(20);
  });

  it("pushWindow preserves order and trims to the cap", async () => {
    for (const v of ["a", "b", "c", "d"]) await store.pushWindow("r1", "sigWindow", v, 3);
    const s = await store.get("r1");
    expect(s.sigWindow).toEqual(["b", "c", "d"]);
  });

  it("pushWindow returns the window contents after pushing", async () => {
    await store.pushWindow("r1", "toolWindow", "A", 5);
    const out = await store.pushWindow("r1", "toolWindow", "B", 5);
    expect(out).toEqual(["A", "B"]);
  });

  it("callTimestamps stay typed as numbers", async () => {
    await store.pushWindow("r1", "callTimestamps", 1234, 5);
    const s = await store.get("r1");
    expect(s.callTimestamps).toEqual([1234]);
    expect(typeof s.callTimestamps[0]).toBe("number");
  });

  it("different runs do not contaminate each other", async () => {
    await store.reset("r2");
    await store.bump("r1", { costUsd: 1 });
    await store.bump("r2", { costUsd: 5 });
    expect((await store.get("r1")).costUsd).toBeCloseTo(1, 6);
    expect((await store.get("r2")).costUsd).toBeCloseTo(5, 6);
  });

  it("reset clears counters and windows", async () => {
    await store.bump("r1", { costUsd: 3, steps: 2 });
    await store.pushWindow("r1", "sigWindow", "a", 5);
    await store.reset("r1");
    const s = await store.get("r1");
    expect(s.costUsd).toBe(0);
    expect(s.stepCount).toBe(0);
    expect(s.sigWindow).toEqual([]);
  });

  it("a cost bucket starts empty and accumulates", async () => {
    // why: these buckets are what make cost_cap window:"hour"/"day" work. If they
    // silently read 0, the cap fails OPEN — on money.
    const key = { bucket: `b-${_name}`, ttlSeconds: 60 };
    expect(await store.getCost(key.bucket)).toBe(0);
    expect(await store.bumpCost(key, 0.25)).toBeCloseTo(0.25, 6);
    expect(await store.bumpCost(key, 0.5)).toBeCloseTo(0.75, 6);
    expect(await store.getCost(key.bucket)).toBeCloseTo(0.75, 6);
  });

  it("different buckets never share a total", async () => {
    const a = { bucket: `x-${_name}`, ttlSeconds: 60 };
    const b = { bucket: `y-${_name}`, ttlSeconds: 60 };
    await store.bumpCost(a, 1);
    await store.bumpCost(b, 2);
    expect(await store.getCost(a.bucket)).toBeCloseTo(1, 6);
    expect(await store.getCost(b.bucket)).toBeCloseTo(2, 6);
  });

  it("concurrent cost bumps lose nothing", async () => {
    const key = { bucket: `c-${_name}`, ttlSeconds: 60 };
    await Promise.all(Array.from({ length: 20 }, () => store.bumpCost(key, 0.05)));
    expect(await store.getCost(key.bucket)).toBeCloseTo(1, 6);
  });

  it("an unknown bucket reads 0 rather than throwing", async () => {
    expect(await store.getCost("never-written")).toBe(0);
  });

  it("startedAt is recorded once and never changes", async () => {
    await store.bump("r1", { steps: 1 });
    const first = (await store.get("r1")).startedAt;
    await store.bump("r1", { steps: 1 });
    expect((await store.get("r1")).startedAt).toBe(first);
  });
});
