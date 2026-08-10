import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Project, Repo } from "./repo/types.js";

/** API key disimpan sebagai hash — key mentah tidak pernah menyentuh database. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function keysMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
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
 * Auth berbasis project API key. Fail-safe: tanpa key yang valid, tidak ada
 * akses sama sekali — termasuk ke Decision API (why: decision tanpa auth berarti
 * siapa pun bisa membaca policy orang lain atau memalsukan run).
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
 * Sediakan project default dari env supaya `docker compose up` langsung jalan.
 * Hanya untuk bootstrap — produksi bikin project lewat API/seed sendiri.
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
