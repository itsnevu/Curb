import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ApprovalHub } from "../approval-hub.js";
import type { Repo } from "../repo/types.js";

const DecideSchema = z.object({
  approve: z.boolean(),
  by: z.string().default("dashboard"),
});

const MAX_WAIT_MS = 60_000;

export function registerApprovals(
  app: FastifyInstance,
  repo: Repo,
  hub: ApprovalHub,
  now: () => number,
) {
  app.get("/v1/approvals", async (req) => {
    const { status } = req.query as { status?: string };
    return repo.listApprovals(req.project!.id, status as never);
  });

  /**
   * `?wait=ms` enables long-polling: the connection hangs until a decision arrives.
   * Without `wait`, this is an ordinary read.
   */
  app.get("/v1/approvals/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { wait } = req.query as { wait?: string };
    const waitMs = Math.min(Number(wait ?? 0) || 0, MAX_WAIT_MS);

    const approval = waitMs > 0 ? await hub.wait(id, waitMs) : await repo.getApproval(id);
    if (!approval) return reply.code(404).send({ error: { message: "approval not found" } });
    if (approval.projectId && approval.projectId !== req.project!.id) {
      return reply.code(404).send({ error: { message: "approval not found" } });
    }
    return approval;
  });

  app.post("/v1/approvals/:id/decide", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = DecideSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: { message: "invalid request body" } });
    }
    const existing = await repo.getApproval(id);
    if (!existing || (existing.projectId && existing.projectId !== req.project!.id)) {
      return reply.code(404).send({ error: { message: "approval not found" } });
    }
    const decided = await repo.decideApproval(
      id,
      parsed.data.approve ? "approved" : "denied",
      parsed.data.by,
      now(),
    );
    if (!decided) return reply.code(404).send({ error: { message: "approval not found" } });

    await repo.appendEvents([
      {
        runId: decided.runId,
        projectId: decided.projectId,
        ts: now(),
        kind: "approval",
        effect: decided.status === "approved" ? "ALLOW" : "DENY",
        policyId: decided.policyId,
        reason: `approval ${decided.status} by ${decided.decidedBy}`,
        context: { approvalId: id, toolName: decided.toolName },
      },
    ]);

    hub.publish(decided); // wake up any SDK currently long-polling
    return decided;
  });
}
