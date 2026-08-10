import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Redis } from "ioredis";
import { RedisRunStateStore, type RedisLike } from "./redis-state.js";

/**
 * Integrasi lawan Redis sungguhan. Dilewati kalau REDIS_URL tidak diset,
 * supaya `pnpm test` tetap jalan di mesin tanpa Redis.
 *   REDIS_URL=redis://localhost:6379 pnpm --filter @curb/policy-engine test
 */
const url = process.env.REDIS_URL;
const suite = url ? describe : describe.skip;

suite("RedisRunStateStore lawan Redis sungguhan", () => {
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

  it("counter float tetap presisi lewat HINCRBYFLOAT", async () => {
    await store.bump(runId, { costUsd: 0.000123, tokens: 7 });
    await store.bump(runId, { costUsd: 0.000877, tokens: 3 });
    const s = await store.get(runId);
    expect(s.costUsd).toBeCloseTo(0.001, 9);
    expect(s.tokens).toBe(10);
  });

  it("50 bump paralel tidak ada yang hilang", async () => {
    await store.reset(runId);
    await Promise.all(Array.from({ length: 50 }, () => store.bump(runId, { costUsd: 0.02, steps: 1 })));
    const s = await store.get(runId);
    expect(s.costUsd).toBeCloseTo(1, 6);
    expect(s.stepCount).toBe(50);
  });

  it("window dipotong oleh LTRIM dan urutannya terjaga", async () => {
    await store.reset(runId);
    for (const v of ["a", "b", "c", "d", "e"]) await store.pushWindow(runId, "sigWindow", v, 3);
    expect((await store.get(runId)).sigWindow).toEqual(["c", "d", "e"]);
  });

  it("TTL terpasang pada key run", async () => {
    await store.bump(runId, { steps: 1 });
    const ttl = await redis.ttl(`curb:run:${runId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });
});
