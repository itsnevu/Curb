import type { CostWindowKey } from "@curb/shared";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Run state is keyed by project AND run id.
 *
 * why: run ids come from the client. Without the project prefix, two tenants that
 * happen to pick the same run id share one cost counter — one can read the other's
 * spend, and either can exhaust the other's cap. The prefix makes collisions
 * impossible across projects.
 */
export function runKey(projectId: string | undefined, runId: string): string {
  return `${projectId ?? "_"}|${runId}`;
}

/**
 * Buckets for cost_cap windows wider than a run. Each bucket lives slightly longer
 * than its window so a call landing on the boundary still sees the spend it should.
 */
export function costWindowKeys(
  projectId: string | undefined,
  nowMs: number,
): { hour: CostWindowKey; day: CostWindowKey } {
  const p = projectId ?? "_";
  return {
    hour: { bucket: `${p}:hour:${Math.floor(nowMs / HOUR_MS)}`, ttlSeconds: 2 * 60 * 60 },
    day: { bucket: `${p}:day:${Math.floor(nowMs / DAY_MS)}`, ttlSeconds: 2 * 24 * 60 * 60 },
  };
}
