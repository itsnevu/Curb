import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Project, Repo } from "./repo/types.js";

/**
 * API keys are stored hashed — the raw key never touches the database.
 * Lookup is by hash, so there is no secret-to-secret comparison to time-attack.
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function apiKeyOf(req: FastifyRequest): string | null {
  const header = req.headers["x-curb-key"];
  if (typeof header === "string" && header) return header;
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

declare module "fastify" {
  interface FastifyRequest {
    project?: Project;
  }
}

/**
 * Project API-key auth. Fail-safe: without a valid key there is no access at all,
 * including to the Decision API — an unauthenticated decision endpoint would let
 * anyone read someone else's policies or forge runs.
 */
export function makeAuth(repo: Repo) {
  return async function authenticate(req: FastifyRequest, reply: FastifyReply) {
    const key = apiKeyOf(req);
    if (!key) {
      return reply.code(401).send({ error: { message: "missing x-curb-key", type: "unauthorized" } });
    }
    const project = await repo.projectByApiKeyHash(hashApiKey(key));
    if (!project) {
      return reply.code(401).send({ error: { message: "unknown api key", type: "unauthorized" } });
    }
    req.project = project;
  };
}

/**
 * Provision a default project from env so `docker compose up` works immediately.
 * Bootstrap only — in production, create projects via the API or your own seed.
 */
export async function ensureDevProject(repo: Repo, apiKey: string | undefined): Promise<Project | null> {
  if (!apiKey) return null;
  return repo.upsertProject({
    id: process.env.CURB_PROJECT_ID ?? "default",
    orgId: process.env.CURB_ORG_ID ?? "default",
    name: "default",
    apiKeyHash: hashApiKey(apiKey),
  });
}
