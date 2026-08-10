import type {
  RunState,
  RunStateDelta,
  RunStateStore,
  WindowKey,
} from "@curb/shared";

export const WINDOW_CAPS: Record<WindowKey, number> = {
  sigWindow: 20,
  toolWindow: 24,
  callTimestamps: 200,
};

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

/** Store in-memory untuk dev/test single-process. Produksi: RedisRunStateStore. */
export class InMemoryRunStateStore implements RunStateStore {
  private map = new Map<string, RunState>();
  constructor(private now: () => number = () => 0) {}

  private ensure(runId: string): RunState {
    let s = this.map.get(runId);
    if (!s) {
      s = emptyState(runId, this.now());
      this.map.set(runId, s);
    }
    return s;
  }

  async get(runId: string): Promise<RunState> {
    return { ...this.ensure(runId) };
  }

  async save(state: RunState): Promise<void> {
    this.map.set(state.runId, { ...state });
  }

  async bump(runId: string, delta: RunStateDelta): Promise<RunState> {
    const s = this.ensure(runId);
    s.tokens += delta.tokens ?? 0;
    s.costUsd += delta.costUsd ?? 0;
    s.stepCount += delta.steps ?? 0;
    return { ...s };
  }

  async pushWindow(
    runId: string,
    key: WindowKey,
    value: string | number,
    cap: number,
  ): Promise<Array<string | number>> {
    const s = this.ensure(runId);
    const next = [...(s[key] as Array<string | number>), value].slice(-cap);
    (s[key] as unknown) = next;
    return [...next];
  }

  async reset(runId: string): Promise<void> {
    this.map.delete(runId);
  }
}
