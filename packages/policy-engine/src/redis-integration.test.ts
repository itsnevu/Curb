import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Redis } from "ioredis";
import { RedisRunStateStore, type RedisLike } from "./redis-state.js";

/**
 * Integration against a real Redis. Skipped when REDIS_URL is unset so `pnpm test`
 * still runs on a machine without Redis.
 *   REDIS_URL=redis://localhost:6379 pnpm --filter @curb/policy-engine test
 */
const url = process.env.REDIS_URL;
const suite = url ? describe : describe.skip;

suite("RedisRunStateStore against a real Redis", () => {
  let redis: Redis;
  let store: RedisRunStateStore;
  const runId = `test-${process.pid}`;

  beforeAll(async () => {
    redis = new Redis(url!);
    store = new RedisRunStateStore(redis as unknown as RedisLike, { ttlSeconds: 60 });
    await store.reset(runId);
  });

  afterAll(async () => {
    await store.reset(runId);
    await redis.quit();
  });

  it("float counters stay precise through HINCRBYFLOAT", async () => {
    await store.bump(runId, { costUsd: 0.000123, tokens: 7 });
    await store.bump(runId, { costUsd: 0.000877, tokens: 3 });
    const s = await store.get(runId);
    expect(s.costUsd).toBeCloseTo(0.001, 9);
    expect(s.tokens).toBe(10);
  });

  it("50 parallel bumps lose nothing", async () => {
    await store.reset(runId);
    await Promise.all(Array.from({ length: 50 }, () => store.bump(runId, { costUsd: 0.02, steps: 1 })));
    const s = await store.get(runId);
    expect(s.costUsd).toBeCloseTo(1, 6);
    expect(s.stepCount).toBe(50);
  });

  it("LTRIM trims the window and order is preserved", async () => {
    await store.reset(runId);
    for (const v of ["a", "b", "c", "d", "e"]) await store.pushWindow(runId, "sigWindow", v, 3);
    expect((await store.get(runId)).sigWindow).toEqual(["c", "d", "e"]);
  });

  it("cost buckets survive as INCRBYFLOAT and carry a TTL", async () => {
    const key = { bucket: `itest-${process.pid}`, ttlSeconds: 90 };
    await store.bumpCost(key, 0.000001);
    await store.bumpCost(key, 0.000002);
    expect(await store.getCost(key.bucket)).toBeCloseTo(0.000003, 9);

    const ttl = await redis.ttl(`curb:run:cost:${key.bucket}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(90);
  });

  it("50 parallel cost bumps against real Redis lose nothing", async () => {
    const key = { bucket: `itest-par-${process.pid}`, ttlSeconds: 90 };
    await Promise.all(Array.from({ length: 50 }, () => store.bumpCost(key, 0.02)));
    expect(await store.getCost(key.bucket)).toBeCloseTo(1, 6);
  });

  it("a TTL is set on the run key", async () => {
    await store.bump(runId, { steps: 1 });
    const ttl = await redis.ttl(`curb:run:${runId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });
});
