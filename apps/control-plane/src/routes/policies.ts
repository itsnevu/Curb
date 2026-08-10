import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { PolicySchema } from "@curb/shared";
import type { Repo } from "../repo/types.js";

/** The server may generate the id; everything else must satisfy PolicySchema. */
const CreateSchema = PolicySchema.extend({
  id: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  scope: PolicySchema.shape.scope.default({}),
  params: PolicySchema.shape.params.default({}),
});

export function registerPolicies(app: FastifyInstance, repo: Repo) {
  app.get("/v1/policies", async (req) => repo.listPolicies(req.project!.id));

  app.get("/v1/policies/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = await repo.getPolicy(req.project!.id, id);
    return p ?? reply.code(404).send({ error: { message: "policy not found" } });
  });

  app.post("/v1/policies", async (req, reply) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { message: "invalid policy", details: parsed.error.format() } });
    }
    const policy = { ...parsed.data, id: parsed.data.id ?? `pol_${randomUUID().slice(0, 8)}` };
    const validated = PolicySchema.parse(policy);
    await repo.putPolicy(req.project!.id, validated);
    return reply.code(201).send(validated);
  });

  app.put("/v1/policies/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await repo.getPolicy(req.project!.id, id);
    if (!existing) return reply.code(404).send({ error: { message: "policy not found" } });
    const parsed = PolicySchema.safeParse({ ...existing, ...(req.body as object), id });
    if (!parsed.success) {
      return reply.code(400).send({ error: { message: "invalid policy", details: parsed.error.format() } });
    }
    await repo.putPolicy(req.project!.id, parsed.data);
    return parsed.data;
  });

  app.delete("/v1/policies/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await repo.deletePolicy(req.project!.id, id);
    return ok ? { ok: true } : reply.code(404).send({ error: { message: "policy not found" } });
  });
}
