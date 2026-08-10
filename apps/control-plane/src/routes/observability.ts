import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Repo, RunSummary } from "../repo/types.js";

const EventSchema = z.object({
  runId: z.string().min(1),
  projectId: z.string().optional(),
  ts: z.number(),
  kind: z.string(),
  effect: z.string(),
  policyId: z.string().optional(),
  reason: z.string().optional(),
  model: z.string().optional(),
  costUsdSnapshot: z.number().optional(),
  tokensSnapshot: z.number().optional(),
});

const IngestSchema = z.object({
  events: z.array(EventSchema).max(1000),
  dropped: z.number().optional(),
});

/** Penerimaan audit dari gateway/SDK, plus pembacaan run & event untuk dashboard. */
export function registerObservability(app: FastifyInstance, repo: Repo) {
  app.post("/v1/events", async (req, reply) => {
    const parsed = IngestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { message: "batch event tidak valid" } });
    }
    const projectId = req.project!.id;
    const events = parsed.data.events;

    await repo.appendEvents(
      events.map((e) => ({
        runId: e.runId,
        projectId,
        ts: e.ts,
        kind: e.kind,
        effect: e.effect,
        policyId: e.policyId,
        reason: e.reason,
        context: { model: e.model, costUsd: e.costUsdSnapshot, tokens: e.tokensSnapshot },
      })),
    );

    // Ringkasan run diperbarui dari event terakhir tiap run (angka snapshot
    // sudah kumulatif, jadi cukup ambil yang paling besar).
    for (const [runId, latest] of latestPerRun(events, projectId)) {
      await repo.upsertRun({ ...latest, id: runId });
    }

    if (parsed.data.dropped) {
      req.log.warn({ dropped: parsed.data.dropped }, "gateway membuang event audit");
    }
    return { ok: true, accepted: events.length };
  });

  app.get("/v1/runs", async (req) => {
    const { limit } = req.query as { limit?: string };
    return repo.listRuns(req.project!.id, Math.min(Number(limit ?? 50) || 50, 200));
  });

  app.get("/v1/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await repo.getRun(req.project!.id, id);
    if (!run) return reply.code(404).send({ error: { message: "run tidak ditemukan" } });
    return { ...run, events: await repo.listEvents(req.project!.id, { runId: id, limit: 200 }) };
  });

  app.get("/v1/events", async (req) => {
    const { runId, limit } = req.query as { runId?: string; limit?: string };
    return repo.listEvents(req.project!.id, { runId, limit: Math.min(Number(limit ?? 100) || 100, 500) });
  });

  /** Angka ringkas untuk kartu di dashboard. */
  app.get("/v1/stats", async (req) => {
    const projectId = req.project!.id;
    const [runs, events, pending] = await Promise.all([
      repo.listRuns(projectId, 200),
      repo.listEvents(projectId, { limit: 500 }),
      repo.listApprovals(projectId, "pending"),
    ]);
    return {
      runs: runs.length,
      running: runs.filter((r) => r.status === "running").length,
      blocked: runs.filter((r) => r.status === "blocked").length,
      totalCostUsd: runs.reduce((a, r) => a + r.totalCostUsd, 0),
      totalTokens: runs.reduce((a, r) => a + r.totalTokens, 0),
      denied: events.filter((e) => e.effect === "DENY").length,
      asked: events.filter((e) => e.effect === "ASK").length,
      pendingApprovals: pending.length,
    };
  });
}

function latestPerRun(events: z.infer<typeof EventSchema>[], projectId: string) {
  const map = new Map<string, Omit<RunSummary, "id">>();
  for (const e of events) {
    const prev = map.get(e.runId);
    const next: Omit<RunSummary, "id"> = {
      projectId,
      startedAt: Math.min(prev?.startedAt ?? e.ts, e.ts),
      status: e.effect === "DENY" ? "blocked" : (prev?.status ?? "running"),
      totalTokens: Math.max(prev?.totalTokens ?? 0, e.tokensSnapshot ?? 0),
      totalCostUsd: Math.max(prev?.totalCostUsd ?? 0, e.costUsdSnapshot ?? 0),
      stepCount: prev?.stepCount ?? 0,
      verdict: e.effect === "DENY" ? (e.policyId ?? prev?.verdict) : prev?.verdict,
    };
    map.set(e.runId, next);
  }
  return map;
}
