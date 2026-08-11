import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { costWindowKeys, evaluate, runKey } from "@curb/policy-engine";
import { digestArgs, type Context, type Decision, type RunState, type RunStateStore } from "@curb/shared";
import type { Approval, EventRecord, Repo } from "../repo/types.js";
import type { Notifier } from "../notify.js";
import { requireCapability } from "../auth.js";

const DecisionRequestSchema = z.object({
  kind: z.enum(["llm_call", "tool_call", "step"]),
  runId: z.string().min(1).max(200),
  toolName: z.string().max(200).optional(),
  toolArgs: z.unknown().optional(),
  sensitivity: z.enum(["low", "medium", "high"]).optional(),
  model: z.string().max(200).optional(),
  env: z.string().max(100).optional(),
  /** Loop-detection signature, when the SDK can compute one for this call. */
  signature: z.string().max(200).optional(),
  /** Cost the caller expects this action to incur, for pre-flight cost caps. */
  estimatedCostUsd: z.number().nonnegative().optional(),
  meta: z.record(z.unknown()).optional(),
});

export interface DecisionDeps {
  repo: Repo;
  store: RunStateStore;
  now: () => number;
  failMode: "open" | "closed";
  notifier: Notifier;
  approvalTtlMs?: number;
}

export function registerDecisions(app: FastifyInstance, deps: DecisionDeps) {
  app.post("/v1/decisions", { preHandler: requireCapability("decisions:write") }, async (req, reply) => {
    const parsed = DecisionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { message: "invalid request body", details: parsed.error.format() } });
    }
    const projectId = req.project!.id;
    const input = parsed.data;
    const t = deps.now();
    // Run state is namespaced by project: run ids come from the caller, so two projects
    // can pick the same one, and they must never share a cost counter.
    const stateKey = runKey(projectId, input.runId);

    const stored = await deps.store.get(stateKey);
    const buckets = costWindowKeys(projectId, t);
    const [hourSpend, daySpend] = await Promise.all([
      deps.store.getCost(buckets.hour.bucket),
      deps.store.getCost(buckets.day.bucket),
    ]);

    // Evaluate against the windows AS THEY WOULD BE with this call included, but only
    // persist once the call is allowed — a blocked call must not pollute the windows.
    const state: RunState = {
      ...stored,
      stepCount: stored.stepCount + (input.kind === "step" ? 1 : 0),
      toolWindow:
        input.kind === "tool_call" && input.toolName
          ? [...stored.toolWindow, input.toolName].slice(-24)
          : stored.toolWindow,
      sigWindow: input.signature ? [...stored.sigWindow, input.signature].slice(-20) : stored.sigWindow,
      callTimestamps: [...stored.callTimestamps, t].slice(-200),
    };

    const ctx: Context = {
      kind: input.kind,
      runId: input.runId,
      projectId,
      env: input.env,
      model: input.model,
      toolName: input.toolName,
      toolArgs: input.toolArgs,
      sensitivity: input.sensitivity,
      signature: input.signature,
      estimatedCostUsd: input.estimatedCostUsd,
      costWindows: { hour: hourSpend, day: daySpend },
      meta: input.meta,
      now: t,
    };

    let decision: Decision;
    try {
      decision = evaluate(ctx, await deps.repo.listPolicies(projectId), state);
    } catch (err) {
      req.log.error({ err }, "policy evaluation failed");
      decision =
        deps.failMode === "open"
          ? { effect: "ALLOW", reason: "policy engine unavailable (fail-open)" }
          : { effect: "DENY", policyId: "curb_fail_closed", reason: "policy engine unavailable (fail-closed)" };
    }

    if (decision.effect !== "DENY") {
      await persist(deps, stateKey, input, t);
    }

    let approvalId: string | undefined;
    if (decision.effect === "ASK") {
      approvalId = `apr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const approval: Approval = {
        id: approvalId,
        runId: input.runId,
        projectId,
        toolName: input.toolName ?? "unknown",
        // Redacted again here: the SDKs redact before sending, but a third-party client
        // might not, and raw secrets must never reach storage.
        args: digestArgs(input.toolArgs),
        reason: decision.reason,
        policyId: decision.policyId,
        status: "pending",
        requestedAt: t,
      };
      await deps.repo.createApproval(approval);
      deps.notifier.approvalRequested(approval);
    }

    const event: EventRecord = {
      runId: input.runId,
      projectId,
      ts: t,
      kind: input.kind,
      effect: decision.effect,
      policyId: decision.policyId,
      reason: decision.reason,
      context: { toolName: input.toolName, model: input.model, sensitivity: input.sensitivity, approvalId },
    };
    await deps.repo.appendEvents([event]);
    deps.notifier.policyTripped(event);

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

    return {
      ...decision,
      approvalId,
      runId: input.runId,
      approvalExpiresAt: approvalId ? t + (deps.approvalTtlMs ?? 60 * 60_000) : undefined,
    };
  });
}

/** Commit this call's effect on the run's counters and windows. */
async function persist(
  deps: DecisionDeps,
  stateKey: string,
  input: z.infer<typeof DecisionRequestSchema>,
  t: number,
): Promise<void> {
  const work: Array<Promise<unknown>> = [deps.store.pushWindow(stateKey, "callTimestamps", t, 200)];
  if (input.kind === "step") work.push(deps.store.bump(stateKey, { steps: 1 }));
  if (input.kind === "tool_call" && input.toolName) {
    work.push(deps.store.pushWindow(stateKey, "toolWindow", input.toolName, 24));
  }
  if (input.signature) work.push(deps.store.pushWindow(stateKey, "sigWindow", input.signature, 20));
  await Promise.all(work);
}
