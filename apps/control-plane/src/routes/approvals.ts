import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ApprovalHub } from "../approval-hub.js";
import { requireCapability } from "../auth.js";
import type { Repo } from "../repo/types.js";

const canRead = { preHandler: requireCapability("approvals:read") };
const canDecide = { preHandler: requireCapability("approvals:decide") };

const DecideSchema = z.object({
  approve: z.boolean(),
  by: z.string().min(1).max(200).default("dashboard"),
});

const MAX_WAIT_MS = 60_000;

export function registerApprovals(
  app: FastifyInstance,
  repo: Repo,
  hub: ApprovalHub,
  now: () => number,
) {
  app.get("/v1/approvals", canRead, async (req) => {
    const { status } = req.query as { status?: string };
    return repo.listApprovals(req.project!.id, status as never);
  });

  /**
   * `?wait=ms` enables long-polling: the connection hangs until a decision arrives.
   * Without `wait`, this is an ordinary read.
   */
  app.get("/v1/approvals/:id", canRead, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { wait } = req.query as { wait?: string };
    const waitMs = Math.min(Number(wait ?? 0) || 0, MAX_WAIT_MS);

    // why check ownership BEFORE waiting: otherwise a caller could hold a connection
    // open against another project's approval id and learn when it gets decided.
    const existing = await repo.getApproval(id);
    if (!existing || (existing.projectId && existing.projectId !== req.project!.id)) {
      return reply.code(404).send({ error: { message: "approval not found" } });
    }

    const approval = waitMs > 0 ? await hub.wait(id, waitMs) : existing;
    if (!approval) return reply.code(404).send({ error: { message: "approval not found" } });
    return approval;
  });

  app.post("/v1/approvals/:id/decide", canDecide, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = DecideSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: { message: "invalid request body" } });
    }
    const existing = await repo.getApproval(id);
    if (!existing || (existing.projectId && existing.projectId !== req.project!.id)) {
      return reply.code(404).send({ error: { message: "approval not found" } });
    }

    const { approval, changed } = await repo.decideApproval(
      id,
      parsed.data.approve ? "approved" : "denied",
      parsed.data.by,
      now(),
    );
    if (!approval) return reply.code(404).send({ error: { message: "approval not found" } });

    // Already decided (or expired): report the existing state, and — importantly — do
    // not write a second audit event for a decision that only happened once.
    if (!changed) {
      return reply.code(409).send({
        error: { message: `approval is already ${approval.status}`, type: "curb_already_decided" },
        approval,
      });
    }

    await repo.appendEvents([
      {
        runId: approval.runId,
        projectId: approval.projectId,
        ts: now(),
        kind: "approval",
        effect: approval.status === "approved" ? "ALLOW" : "DENY",
        policyId: approval.policyId,
        reason: `approval ${approval.status} by ${approval.decidedBy}`,
        context: { approvalId: id, toolName: approval.toolName },
      },
    ]);

    hub.publish(approval); // wake up any SDK currently long-polling
    return approval;
  });
}
