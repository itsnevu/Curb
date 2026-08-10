import type { RunState, RunStateStore } from "@curb/shared";

export function emptyState(runId: string, now: number): RunState {
  return {
    runId,
    startedAt: now,
    tokens: 0,
    costUsd: 0,
    stepCount: 0,
    sigWindow: [],
    toolWindow: [],
    callTimestamps: [],
  };
}

/** Store in-memory untuk dev/test. Ganti dengan Redis di produksi (lihat RedisRunStateStore). */
export class InMemoryRunStateStore implements RunStateStore {
  private map = new Map<string, RunState>();
  constructor(private now: () => number = () => 0) {}

  async get(runId: string): Promise<RunState> {
    return this.map.get(runId) ?? emptyState(runId, this.now());
  }
  async save(state: RunState): Promise<void> {
    this.map.set(state.runId, state);
  }
}

// TODO(M1): RedisRunStateStore pakai ioredis — HSET per run:{id}, TTL, INCR counter.
