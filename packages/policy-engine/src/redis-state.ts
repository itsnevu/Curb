import type {
  CostWindowKey,
  RunState,
  RunStateDelta,
  RunStateStore,
  WindowKey,
} from "@curb/shared";
import { WINDOW_CAPS, emptyState } from "./state.js";

/** The subset of ioredis we use — easy to mock, and not tied to a specific version. */
export interface RedisLike {
  hgetall(key: string): Promise<Record<string, string>>;
  get(key: string): Promise<string | null>;
  incrbyfloat(key: string, inc: number): Promise<string>;
  hsetnx(key: string, field: string, value: string | number): Promise<number>;
  hincrby(key: string, field: string, inc: number): Promise<number>;
  hincrbyfloat(key: string, field: string, inc: number): Promise<string>;
  hset(key: string, ...args: Array<string | number>): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  rpush(key: string, value: string | number): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  del(...keys: string[]): Promise<number>;
}

const NUMERIC_WINDOWS: WindowKey[] = ["callTimestamps"];

export interface RedisRunStateStoreOptions {
  /** Per-run state TTL. Defaults to 24 hours. */
  ttlSeconds?: number;
  keyPrefix?: string;
  now?: () => number;
}

/**
 * Production state store. Counters increment through HINCRBY/HINCRBYFLOAT so they
 * stay atomic across gateway instances — a read-modify-write would let concurrent
 * requests leak past a cost cap.
 */
export class RedisRunStateStore implements RunStateStore {
  private ttl: number;
  private prefix: string;
  private now: () => number;

  constructor(
    private redis: RedisLike,
    opts: RedisRunStateStoreOptions = {},
  ) {
    this.ttl = opts.ttlSeconds ?? 60 * 60 * 24;
    this.prefix = opts.keyPrefix ?? "curb:run:";
    this.now = opts.now ?? (() => Date.now());
  }

  private key(runId: string) {
    return `${this.prefix}${runId}`;
  }
  private winKey(runId: string, w: WindowKey) {
    return `${this.prefix}${runId}:${w}`;
  }

  private async touch(runId: string): Promise<number> {
    const started = this.now();
    await this.redis.hsetnx(this.key(runId), "startedAt", started);
    await this.redis.expire(this.key(runId), this.ttl);
    return started;
  }

  async get(runId: string): Promise<RunState> {
    const [h, sig, tools, ts] = await Promise.all([
      this.redis.hgetall(this.key(runId)),
      this.redis.lrange(this.winKey(runId, "sigWindow"), 0, -1),
      this.redis.lrange(this.winKey(runId, "toolWindow"), 0, -1),
      this.redis.lrange(this.winKey(runId, "callTimestamps"), 0, -1),
    ]);
    const base = emptyState(runId, this.now());
    if (h && Object.keys(h).length > 0) {
      base.startedAt = Number(h.startedAt ?? base.startedAt);
      base.tokens = Number(h.tokens ?? 0);
      base.costUsd = Number(h.costUsd ?? 0);
      base.stepCount = Number(h.stepCount ?? 0);
    }
    base.sigWindow = sig ?? [];
    base.toolWindow = tools ?? [];
    base.callTimestamps = (ts ?? []).map(Number);
    return base;
  }

  /** Rarely used (bootstrap and tests). The hot path uses bump()/pushWindow(). */
  async save(state: RunState): Promise<void> {
    await this.redis.hset(
      this.key(state.runId),
      "startedAt",
      state.startedAt,
      "tokens",
      state.tokens,
      "costUsd",
      state.costUsd,
      "stepCount",
      state.stepCount,
    );
    await this.redis.expire(this.key(state.runId), this.ttl);
  }

  async bump(runId: string, delta: RunStateDelta): Promise<RunState> {
    await this.touch(runId);
    const k = this.key(runId);
    if (delta.tokens) await this.redis.hincrby(k, "tokens", delta.tokens);
    if (delta.steps) await this.redis.hincrby(k, "stepCount", delta.steps);
    if (delta.costUsd) await this.redis.hincrbyfloat(k, "costUsd", delta.costUsd);
    return this.get(runId);
  }

  async pushWindow(
    runId: string,
    key: WindowKey,
    value: string | number,
    cap: number = WINDOW_CAPS[key],
  ): Promise<Array<string | number>> {
    await this.touch(runId);
    const k = this.winKey(runId, key);
    await this.redis.rpush(k, value);
    await this.redis.ltrim(k, -cap, -1);
    await this.redis.expire(k, this.ttl);
    const out = await this.redis.lrange(k, 0, -1);
    return NUMERIC_WINDOWS.includes(key) ? out.map(Number) : out;
  }

  /** Cross-run cost buckets (per project, per hour/day). Atomic, like the run counters. */
  async bumpCost(key: CostWindowKey, costUsd: number): Promise<number> {
    const k = this.costKey(key.bucket);
    const total = await this.redis.incrbyfloat(k, costUsd);
    await this.redis.expire(k, key.ttlSeconds);
    return Number(total);
  }

  async getCost(bucket: string): Promise<number> {
    const raw = await this.redis.get(this.costKey(bucket));
    const n = Number(raw ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  private costKey(bucket: string) {
    return `${this.prefix}cost:${bucket}`;
  }

  async reset(runId: string): Promise<void> {
    await this.redis.del(
      this.key(runId),
      this.winKey(runId, "sigWindow"),
      this.winKey(runId, "toolWindow"),
      this.winKey(runId, "callTimestamps"),
    );
  }
}
