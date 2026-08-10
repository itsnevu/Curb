import { describe, it, expect, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import type { RunStateStore } from "@curb/shared";
import { InMemoryRunStateStore } from "./state.js";
import { RedisRunStateStore, type RedisLike } from "./redis-state.js";

/**
 * Kontrak store diuji dua kali: in-memory (dev) dan Redis (produksi).
 * why: dua implementasi HARUS berperilaku identik, kalau tidak policy
 * berubah arti begitu dipindah ke produksi.
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

  it("run baru mulai dari nol", async () => {
    const s = await store.get("r1");
    expect(s.costUsd).toBe(0);
    expect(s.tokens).toBe(0);
    expect(s.stepCount).toBe(0);
    expect(s.sigWindow).toEqual([]);
  });

  it("bump menambah counter secara akumulatif", async () => {
    await store.bump("r1", { tokens: 100, costUsd: 0.25, steps: 1 });
    await store.bump("r1", { tokens: 50, costUsd: 0.5, steps: 1 });
    const s = await store.get("r1");
    expect(s.tokens).toBe(150);
    expect(s.costUsd).toBeCloseTo(0.75, 6);
    expect(s.stepCount).toBe(2);
  });

  it("bump konkuren tidak kehilangan update (atomik)", async () => {
    await Promise.all(
      Array.from({ length: 20 }, () => store.bump("r1", { costUsd: 0.1, steps: 1 })),
    );
    const s = await store.get("r1");
    expect(s.costUsd).toBeCloseTo(2, 6);
    expect(s.stepCount).toBe(20);
  });

  it("pushWindow menjaga urutan dan memotong sesuai cap", async () => {
    for (const v of ["a", "b", "c", "d"]) await store.pushWindow("r1", "sigWindow", v, 3);
    const s = await store.get("r1");
    expect(s.sigWindow).toEqual(["b", "c", "d"]);
  });

  it("pushWindow mengembalikan isi window setelah push", async () => {
    await store.pushWindow("r1", "toolWindow", "A", 5);
    const out = await store.pushWindow("r1", "toolWindow", "B", 5);
    expect(out).toEqual(["A", "B"]);
  });

  it("callTimestamps tetap bertipe number", async () => {
    await store.pushWindow("r1", "callTimestamps", 1234, 5);
    const s = await store.get("r1");
    expect(s.callTimestamps).toEqual([1234]);
    expect(typeof s.callTimestamps[0]).toBe("number");
  });

  it("run berbeda tidak saling mencemari", async () => {
    await store.reset("r2");
    await store.bump("r1", { costUsd: 1 });
    await store.bump("r2", { costUsd: 5 });
    expect((await store.get("r1")).costUsd).toBeCloseTo(1, 6);
    expect((await store.get("r2")).costUsd).toBeCloseTo(5, 6);
  });

  it("reset menghapus counter dan window", async () => {
    await store.bump("r1", { costUsd: 3, steps: 2 });
    await store.pushWindow("r1", "sigWindow", "a", 5);
    await store.reset("r1");
    const s = await store.get("r1");
    expect(s.costUsd).toBe(0);
    expect(s.stepCount).toBe(0);
    expect(s.sigWindow).toEqual([]);
  });

  it("startedAt tercatat sekali dan tidak berubah", async () => {
    await store.bump("r1", { steps: 1 });
    const first = (await store.get("r1")).startedAt;
    await store.bump("r1", { steps: 1 });
    expect((await store.get("r1")).startedAt).toBe(first);
  });
});
