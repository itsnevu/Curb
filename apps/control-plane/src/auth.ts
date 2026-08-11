import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { can, type Capability, type Role } from "./rbac.js";
import type { ApiKey, Project, Repo } from "./repo/types.js";

/**
 * API keys are stored hashed — the raw key never touches the database.
 * Lookup is by hash, so there is no secret-to-secret comparison to time-attack.
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Mints a key the caller sees exactly once; only its hash is ever persisted. */
export function generateApiKey(): string {
  return `curb_${randomBytes(24).toString("base64url")}`;
}

export function apiKeyOf(req: FastifyRequest): string | null {
  const header = req.headers["x-curb-key"];
  if (typeof header === "string" && header) return header;
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

/** Who is calling, in which org, acting on which project. */
export interface Principal {
  orgId: string;
  role: Role;
  keyId: string;
  keyName: string;
  /** Set when the key is pinned to one project; undefined for an org-wide key. */
  scopedProjectId?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    project?: Project;
    principal?: Principal;
  }
}

const PROJECT_HEADER = "x-curb-project";

function unauthorized(reply: FastifyReply, message: string) {
  return reply.code(401).send({ error: { message, type: "unauthorized" } });
}

/**
 * API-key auth, tenancy and project selection in one hook.
 *
 * Fail-safe: without a valid key there is no access at all, including to the Decision
 * API — an unauthenticated decision endpoint would let anyone read someone else's
 * policies or forge runs.
 *
 * A key names its org. The project it acts on is either pinned to the key, or — for an
 * org-wide key — chosen per request via `X-Curb-Project`. That header is only ever a
 * choice WITHIN the caller's own org: it is checked against the key's org before use, so
 * it can select a project but never cross a tenant boundary.
 */
export function makeAuth(repo: Repo) {
  return async function authenticate(req: FastifyRequest, reply: FastifyReply) {
    const key = apiKeyOf(req);
    if (!key) return unauthorized(reply, "missing x-curb-key");

    const apiKey = await repo.apiKeyByHash(hashApiKey(key));
    if (!apiKey) return unauthorized(reply, "unknown api key");

    req.principal = {
      orgId: apiKey.orgId,
      role: apiKey.role,
      keyId: apiKey.id,
      keyName: apiKey.name,
      scopedProjectId: apiKey.projectId,
    };

    const requested = req.headers[PROJECT_HEADER];
    const wanted = typeof requested === "string" && requested ? requested : undefined;

    if (apiKey.projectId) {
      // A pinned key may state its own project redundantly, but may not name another —
      // silently ignoring the mismatch would make the header look like it worked.
      if (wanted && wanted !== apiKey.projectId) {
        return reply.code(403).send({
          error: { message: "key is not scoped to that project", type: "forbidden" },
        });
      }
      const project = await repo.getProject(apiKey.orgId, apiKey.projectId);
      if (!project) return unauthorized(reply, "project no longer exists");
      req.project = project;
      return;
    }

    // Org-wide key. With exactly one project the header is a formality, so default to it.
    const projects = await repo.listProjects(apiKey.orgId);
    const target = wanted ?? (projects.length === 1 ? projects[0].id : undefined);
    if (!target) {
      return reply.code(400).send({
        error: {
          message: "org-wide key must select a project with the X-Curb-Project header",
          type: "project_required",
          projects: projects.map((p) => p.id),
        },
      });
    }
    const project = projects.find((p) => p.id === target);
    // 404, not 403: whether a project exists in someone else's org is not ours to reveal.
    if (!project) {
      return reply.code(404).send({ error: { message: "project not found", type: "not_found" } });
    }
    req.project = project;
  };
}

/**
 * Route guard. Applied per route rather than globally because the split is per verb:
 * the same role that may read a policy usually may not write one.
 */
export function requireCapability(capability: Capability) {
  return async function guard(req: FastifyRequest, reply: FastifyReply) {
    const principal = req.principal;
    if (!principal) return unauthorized(reply, "missing x-curb-key");
    if (!can(principal.role, capability)) {
      return reply.code(403).send({
        error: {
          message: `role '${principal.role}' may not ${capability}`,
          type: "forbidden",
          requiredCapability: capability,
        },
      });
    }
  };
}

export interface ProvisionOptions {
  projectId: string;
  orgId: string;
  key: string;
  name?: string;
  role?: Role;
  /** Mint the key org-wide instead of pinning it to `projectId`. */
  orgWide?: boolean;
}

/**
 * Create a project and a key that can reach it, in one step.
 *
 * Idempotent on the key: re-provisioning an existing one is a no-op rather than a unique
 * -constraint failure, which is what makes it safe to call on every boot.
 */
export async function provisionProject(repo: Repo, opts: ProvisionOptions): Promise<Project> {
  const project = await repo.upsertProject({
    id: opts.projectId,
    orgId: opts.orgId,
    name: opts.name ?? opts.projectId,
  });
  const keyHash = hashApiKey(opts.key);
  if (!(await repo.apiKeyByHash(keyHash))) {
    await repo.createApiKey({
      id: `key_${randomUUID().slice(0, 8)}`,
      orgId: opts.orgId,
      projectId: opts.orgWide ? undefined : project.id,
      name: opts.name ?? "provisioned key",
      keyHash,
      role: opts.role ?? "admin",
      createdAt: Date.now(),
    });
  }
  return project;
}

/**
 * Provision a default org, project and admin key from env so `docker compose up` works
 * immediately. Bootstrap only — in production, create projects and keys via the API.
 */
export async function ensureDevProject(repo: Repo, apiKey: string | undefined): Promise<Project | null> {
  if (!apiKey) return null;
  return provisionProject(repo, {
    projectId: process.env.CURB_PROJECT_ID ?? "default",
    orgId: process.env.CURB_ORG_ID ?? "default",
    key: apiKey,
    name: "default",
    role: "admin",
  });
}
