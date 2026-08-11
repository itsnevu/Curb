import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryRunStateStore } from "@curb/policy-engine";
import { buildApp } from "./app.js";
import { hashApiKey, provisionProject } from "./auth.js";
import { can, ROLES, type Role } from "./rbac.js";
import { MemoryRepo } from "./repo/memory.js";

const ADMIN = "admin-key";

let app: FastifyInstance;
let repo: MemoryRepo;

/** Mints a key of `role` in org1, pinned to proj1 unless `orgWide`. */
async function key(name: string, role: Role, opts: { orgWide?: boolean; project?: string } = {}) {
  await repo.createApiKey({
    id: `key_${name}`,
    orgId: "org1",
    projectId: opts.orgWide ? undefined : (opts.project ?? "proj1"),
    name,
    keyHash: hashApiKey(name),
    role,
    createdAt: 1_000,
  });
  return name;
}

const H = (k: string, extra: Record<string, string> = {}) => ({
  "x-curb-key": k,
  "content-type": "application/json",
  ...extra,
});

const get = (url: string, k: string, extra?: Record<string, string>) =>
  app.inject({ method: "GET", url, headers: H(k, extra) });
const post = (url: string, payload: unknown, k: string, extra?: Record<string, string>) =>
  app.inject({ method: "POST", url, headers: H(k, extra), payload: payload as object });

const policy = (over: Record<string, unknown> = {}) => ({
  name: "test", type: "cost_cap", action: "deny", params: { maxUsd: 2 }, scope: {}, enabled: true, ...over,
});

beforeEach(async () => {
  repo = new MemoryRepo();
  await provisionProject(repo, { projectId: "proj1", orgId: "org1", name: "one", key: ADMIN });
  app = buildApp({ repo, store: new InMemoryRunStateStore(() => 1_000), now: () => 1_000 });
});

describe("capability table", () => {
  it("no role but admin may write policies", () => {
    const writers = ROLES.filter((r) => can(r, "policies:write"));
    expect(writers).toEqual(["admin"]);
  });
  it("an agent can submit decisions but never edit the policies judging it", () => {
    expect(can("agent", "decisions:write")).toBe(true);
    expect(can("agent", "policies:write")).toBe(false);
  });
  it("an operator can release a held call but not loosen the policy that held it", () => {
    expect(can("operator", "approvals:decide")).toBe(true);
    expect(can("operator", "policies:write")).toBe(false);
  });
  it("a viewer cannot decide an approval or write anything", () => {
    expect(can("viewer", "approvals:decide")).toBe(false);
    expect(can("viewer", "decisions:write")).toBe(false);
  });
});

describe("role enforcement on routes", () => {
  it("a viewer may read policies but not create one", async () => {
    const k = await key("viewer1", "viewer");
    expect((await get("/v1/policies", k)).statusCode).toBe(200);
    const res = await post("/v1/policies", policy(), k);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ type: "forbidden", requiredCapability: "policies:write" });
  });

  it("an operator may decide an approval; a viewer may not", async () => {
    await post("/v1/policies", policy({ type: "tool_permission", action: "ask", params: { tools: ["rm"] } }), ADMIN);
    const decision = await post("/v1/decisions", { kind: "tool_call", runId: "r1", toolName: "rm" }, ADMIN);
    const approvalId = decision.json().approvalId as string;
    expect(approvalId).toBeTruthy();

    const viewer = await key("viewer2", "viewer");
    expect((await post(`/v1/approvals/${approvalId}/decide`, { approve: true }, viewer)).statusCode).toBe(403);

    const operator = await key("op1", "operator");
    const ok = await post(`/v1/approvals/${approvalId}/decide`, { approve: true, by: "op1" }, operator);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "approved", decidedBy: "op1" });
  });

  it("an agent may submit decisions and events but not read the audit log", async () => {
    const k = await key("agent1", "agent");
    expect((await post("/v1/decisions", { kind: "step", runId: "r2" }, k)).statusCode).toBe(200);
    expect((await post("/v1/events", { events: [] }, k)).statusCode).toBe(200);
    expect((await get("/v1/events", k)).statusCode).toBe(403);
    expect((await get("/v1/runs", k)).statusCode).toBe(403);
  });

  it("only an admin may mint or list keys", async () => {
    const op = await key("op2", "operator");
    expect((await get("/v1/keys", op)).statusCode).toBe(403);
    expect((await post("/v1/keys", { name: "x", role: "viewer" }, op)).statusCode).toBe(403);
    expect((await get("/v1/keys", ADMIN)).statusCode).toBe(200);
  });

  it("/v1/me is open to any valid key, and reports the role", async () => {
    const k = await key("viewer3", "viewer");
    expect((await get("/v1/me", k)).json()).toMatchObject({
      orgId: "org1", role: "viewer", projectId: "proj1", scopedProjectId: "proj1",
    });
  });
});

describe("tenancy", () => {
  beforeEach(async () => {
    await provisionProject(repo, { projectId: "proj2", orgId: "org2", name: "two", key: "org2-admin" });
    await post("/v1/policies", policy({ name: "org1 policy" }), ADMIN);
  });

  it("an org-wide key cannot reach a project outside its org", async () => {
    await repo.createApiKey({
      id: "key_org2wide", orgId: "org2", name: "wide", keyHash: hashApiKey("org2-wide"),
      role: "admin", createdAt: 1_000,
    });
    // proj1 exists — but not in org2, and the answer must not reveal that it exists at all,
    // so this is the same 404 an entirely made-up id would get.
    expect((await get("/v1/policies", "org2-wide", { "x-curb-project": "proj1" })).statusCode).toBe(404);
    expect((await get("/v1/policies", "org2-wide", { "x-curb-project": "nope" })).statusCode).toBe(404);
  });

  it("a project-scoped key cannot switch project with a header", async () => {
    const res = await get("/v1/policies", ADMIN, { "x-curb-project": "proj2" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.type).toBe("forbidden");
  });

  it("policies do not leak across orgs", async () => {
    expect((await get("/v1/policies", ADMIN)).json()).toHaveLength(1);
    expect((await get("/v1/policies", "org2-admin")).json()).toHaveLength(0);
  });

  it("an admin only sees the projects and keys of their own org", async () => {
    await provisionProject(repo, { projectId: "proj1b", orgId: "org1", name: "one-b", key: "k1b" });
    const mine = (await get("/v1/projects", ADMIN)).json() as Array<{ id: string }>;
    expect(mine.map((p) => p.id)).toEqual(["proj1"]); // scoped key: only its own project
    const theirs = (await get("/v1/keys", "org2-admin")).json() as Array<{ orgId: string }>;
    expect(theirs.every((k) => k.orgId === "org2")).toBe(true);
  });

  it("an admin cannot claim a project id that belongs to another org", async () => {
    const res = await post("/v1/projects", { id: "proj2", name: "steal" }, ADMIN);
    expect(res.statusCode).toBe(409);
    // and the victim's project is untouched
    expect((await repo.getProject("org2", "proj2"))!.name).toBe("two");
  });

  it("an admin cannot pin a key to a project outside their org", async () => {
    const res = await post("/v1/keys", { name: "x", role: "agent", projectId: "proj2" }, ADMIN);
    expect(res.statusCode).toBe(404);
  });
});

describe("org-wide keys", () => {
  let orgWide: string;

  beforeEach(async () => {
    await provisionProject(repo, { projectId: "proj1b", orgId: "org1", name: "one-b", key: "unused" });
    orgWide = await key("wide", "admin", { orgWide: true });
  });

  it("must name a project when the org has more than one", async () => {
    const res = await get("/v1/policies", orgWide);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ type: "project_required" });
    expect(res.json().error.projects).toEqual(["proj1", "proj1b"]);
  });

  it("acts on the project it names, and keeps them separate", async () => {
    const hdr = (p: string) => ({ "x-curb-project": p });
    expect((await post("/v1/policies", policy(), orgWide, hdr("proj1"))).statusCode).toBe(201);
    expect((await get("/v1/policies", orgWide, hdr("proj1"))).json()).toHaveLength(1);
    expect((await get("/v1/policies", orgWide, hdr("proj1b"))).json()).toHaveLength(0);
  });

  it("sees every project in its org in the switcher", async () => {
    const list = (await get("/v1/projects", orgWide, { "x-curb-project": "proj1" })).json() as Array<{ id: string }>;
    expect(list.map((p) => p.id)).toEqual(["proj1", "proj1b"]);
  });
});

describe("key lifecycle", () => {
  it("mints a key that works, returns the plaintext exactly once, then revokes it", async () => {
    const created = await post("/v1/keys", { name: "ci", role: "agent" }, ADMIN);
    expect(created.statusCode).toBe(201);
    const { key: plaintext, id } = created.json() as { key: string; id: string };
    expect(plaintext).toMatch(/^curb_/);

    expect((await post("/v1/decisions", { kind: "step", runId: "r3" }, plaintext)).statusCode).toBe(200);

    // The plaintext is never readable again — only its metadata.
    const listed = (await get("/v1/keys", ADMIN)).json() as Array<Record<string, unknown>>;
    expect(listed.find((k) => k.id === id)).not.toHaveProperty("key");

    expect((await app.inject({ method: "DELETE", url: `/v1/keys/${id}`, headers: H(ADMIN) })).statusCode).toBe(200);
    expect((await post("/v1/decisions", { kind: "step", runId: "r4" }, plaintext)).statusCode).toBe(401);
  });

  it("refuses to revoke the key making the request", async () => {
    const me = (await get("/v1/me", ADMIN)).json() as { keyId: string };
    const res = await app.inject({ method: "DELETE", url: `/v1/keys/${me.keyId}`, headers: H(ADMIN) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe("self_revoke");
    expect((await get("/v1/policies", ADMIN)).statusCode).toBe(200);
  });

  it("cannot revoke a key belonging to another org", async () => {
    await provisionProject(repo, { projectId: "proj2", orgId: "org2", name: "two", key: "org2-admin" });
    const victim = ((await get("/v1/keys", "org2-admin")).json() as Array<{ id: string }>)[0];
    const res = await app.inject({ method: "DELETE", url: `/v1/keys/${victim.id}`, headers: H(ADMIN) });
    expect(res.statusCode).toBe(404);
    expect((await get("/v1/policies", "org2-admin")).statusCode).toBe(200);
  });

  it("rejects an unknown role at write time", async () => {
    expect((await post("/v1/keys", { name: "x", role: "superuser" }, ADMIN)).statusCode).toBe(400);
  });
});
