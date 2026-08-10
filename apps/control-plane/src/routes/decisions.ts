import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { evaluate } from "@curb/policy-engine";
import type { Context, Decision, RunStateStore } from "@curb/shared";
import type { Repo } from "../repo/types.js";
import { digestArgs } from "../redact.js";

const DecisionRequestSchema = z.object({
  kind: z.enum(["llm_call", "tool_call", "step"]),
  runId: z.string().min(1),
  toolName: z.string().optional(),
  toolArgs: z.unknown().optional(),
  sensitivity: z.enum(["low", "medium", "high"]).optional(),
  model: z.string().optional(),
  env: z.string().optional(),
  meta: z.record(z.unknown()).optional(),
});

export interface DecisionDeps {
  repo: Repo;
  store: RunStateStore;
  now: () => number;
  failMode: "open" | "closed";
}

export function registerDecisions(app: FastifyInstance, deps: DecisionDeps) {
  app.post("/v1/decisions", async (req, reply) => {
    const parsed = DecisionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { message: "body tidak valid", details: parsed.error.format() } });
    }
    const projectId = req.project!.id;
    const input = parsed.data;
    const t = deps.now();

    // Window & counter di-update sebelum evaluate supaya call ini ikut terhitung.
    if (input.kind === "tool_call" && input.toolName) {
      await deps.store.pushWindow(input.runId, "toolWindow", input.toolName, 24);
    }
    if (input.kind === "step") {
      await deps.store.bump(input.runId, { steps: 1 });
    }
    await deps.store.pushWindow(input.runId, "callTimestamps", t, 200);
    const state = await deps.store.get(input.runId);

    const ctx: Context = { ...input, projectId, now: t } as Context;

    let decision: Decision;
    try {
      decision = evaluate(ctx, await deps.repo.listPolicies(projectId), state);
    } catch (err) {
      req.log.error({ err }, "evaluasi policy gagal");
      decision =
        deps.failMode === "open"
          ? { effect: "ALLOW", reason: "engine tidak tersedia (fail-open)" }
          : { effect: "DENY", policyId: "curb_fail_closed", reason: "policy engine tidak tersedia (fail-closed)" };
    }

    let approvalId: string | undefined;
    if (decision.effect === "ASK") {
      approvalId = `apr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await deps.repo.createApproval({
        id: approvalId,
        runId: input.runId,
        projectId,
        toolName: input.toolName ?? "unknown",
        // why: argumen tool bisa berisi rahasia — simpan ringkasannya saja.
        args: digestArgs(input.toolArgs),
        reason: decision.reason,
        policyId: decision.policyId,
        status: "pending",
        requestedAt: t,
      });
    }

    await deps.repo.appendEvents([
      {
        runId: input.runId,
        projectId,
        ts: t,
        kind: input.kind,
        effect: decision.effect,
        policyId: decision.policyId,
        reason: decision.reason,
        context: { toolName: input.toolName, model: input.model, sensitivity: input.sensitivity, approvalId },
      },
    ]);

    await deps.repo.upsertRun({
      id: input.runId,
      projectId,
      startedAt: state.startedAt || t,
      status: decision.effect === "DENY" ? "blocked" : "running",
      totalTokens: state.tokens,
      totalCostUsd: state.costUsd,
      stepCount: state.stepCount,
      verdict: decision.effect === "DENY" ? decision.policyId : undefined,
    });

    return { ...decision, approvalId, runId: input.runId };
  });
}
