import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { generateApiKey, hashApiKey, requireCapability } from "../auth.js";
import { capabilitiesOf, ROLES } from "../rbac.js";
import type { ApiKey, Repo } from "../repo/types.js";

const admin = { preHandler: requireCapability("org:admin") };

const ID = z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "invalid id");

const CreateProjectSchema = z.object({
  id: ID.optional(),
  name: z.string().min(1).max(200),
});

const CreateKeySchema = z.object({
  name: z.string().min(1).max(200),
  role: z.enum(ROLES),
  /** Omit for an org-wide key that can act on every project in the org. */
  projectId: ID.optional(),
});

/** Keys are secrets: everything but the plaintext, which is returned exactly once. */
function publicKey(k: ApiKey) {
  return {
    id: k.id,
    orgId: k.orgId,
    projectId: k.projectId ?? null,
    name: k.name,
    role: k.role,
    createdAt: k.createdAt,
    revokedAt: k.revokedAt ?? null,
  };
}

/** Org self-service: who am I, which projects exist, and key management. */
export function registerOrg(app: FastifyInstance, repo: Repo, now: () => number) {
  /**
   * Deliberately ungated: any valid key may ask what it is. The dashboard needs this to
   * know which controls to render, and it reveals nothing the caller did not already hold.
   */
  app.get("/v1/me", async (req) => ({
    orgId: req.principal!.orgId,
    role: req.principal!.role,
    keyId: req.principal!.keyId,
    keyName: req.principal!.keyName,
    scopedProjectId: req.principal!.scopedProjectId ?? null,
    projectId: req.project!.id,
    capabilities: capabilitiesOf(req.principal!.role),
  }));

  /**
   * Visible to anyone who can read, so an org-wide key can populate a project switcher
   * without needing admin.
   */
  app.get("/v1/projects", { preHandler: requireCapability("read") }, async (req) => {
    const projects = await repo.listProjects(req.principal!.orgId);
    const scoped = req.principal!.scopedProjectId;
    return (scoped ? projects.filter((p) => p.id === scoped) : projects).map((p) => ({
      id: p.id,
      orgId: p.orgId,
      name: p.name,
    }));
  });

  app.post("/v1/projects", admin, async (req, reply) => {
    const parsed = CreateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { message: "invalid project", details: parsed.error.format() } });
    }
    const orgId = req.principal!.orgId;
    const id = parsed.data.id ?? `prj_${randomUUID().slice(0, 8)}`;

    // Project ids are globally unique, so a caller-supplied id that already belongs to
    // another org would rebind THAT org's project onto this one. Refuse; do not say whose.
    const existing = await repo.projectById(id);
    if (existing && existing.orgId !== orgId) {
      return reply.code(409).send({ error: { message: "project id already in use", type: "conflict" } });
    }

    const project = await repo.upsertProject({ id, orgId, name: parsed.data.name });
    return reply.code(existing ? 200 : 201).send({ id: project.id, orgId, name: project.name });
  });

  app.get("/v1/keys", admin, async (req) => {
    const keys = await repo.listApiKeys(req.principal!.orgId);
    return keys.map(publicKey);
  });

  app.post("/v1/keys", admin, async (req, reply) => {
    const parsed = CreateKeySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { message: "invalid key", details: parsed.error.format() } });
    }
    const orgId = req.principal!.orgId;

    // A key may only be pinned to a project of the caller's own org — otherwise an admin
    // could mint themselves access to a tenant they do not belong to.
    if (parsed.data.projectId) {
      const project = await repo.getProject(orgId, parsed.data.projectId);
      if (!project) {
        return reply.code(404).send({ error: { message: "project not found", type: "not_found" } });
      }
    }

    const plaintext = generateApiKey();
    const key = await repo.createApiKey({
      id: `key_${randomUUID().slice(0, 8)}`,
      orgId,
      projectId: parsed.data.projectId,
      name: parsed.data.name,
      keyHash: hashApiKey(plaintext),
      role: parsed.data.role,
      createdAt: now(),
    });
    // The only time the plaintext exists outside the caller's own memory. It is not
    // recoverable afterwards, and it is not logged.
    return reply.code(201).send({ ...publicKey(key), key: plaintext });
  });

  app.delete("/v1/keys/:id", admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === req.principal!.keyId) {
      // Revoking the key you are holding locks you out mid-request, and if it is the last
      // admin key, locks the org out permanently.
      return reply.code(400).send({
        error: { message: "cannot revoke the key you are authenticating with", type: "self_revoke" },
      });
    }
    const ok = await repo.revokeApiKey(req.principal!.orgId, id, now());
    return ok ? { ok: true } : reply.code(404).send({ error: { message: "key not found" } });
  });
}
