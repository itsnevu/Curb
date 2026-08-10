import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryRunStateStore } from "@curb/policy-engine";
import { Curb, PolicyViolation } from "@curb/sdk";
import { buildApp } from "./app.js";
import { hashApiKey } from "./auth.js";
import { MemoryRepo } from "./repo/memory.js";

/**
 * Acceptance M3: SDK sungguhan berbicara ke control plane sungguhan lewat HTTP.
 * Tidak ada yang dipalsukan selain database.
 */
const KEY = "kunci-e2e";
let app: FastifyInstance;
let repo: MemoryRepo;
let curb: Curb;
let baseUrl: string;

const H = { "x-curb-key": KEY, "content-type": "application/json" };

beforeEach(async () => {
  repo = new MemoryRepo();
  await repo.upsertProject({ id: "proj1", orgId: "org1", name: "e2e", apiKeyHash: hashApiKey(KEY) });
  app = buildApp({ repo, store: new InMemoryRunStateStore(() => Date.now()) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  curb = new Curb({ baseUrl, apiKey: KEY, approvalTimeoutMs: 5_000 });
});

afterEach(async () => {
  await app.close();
});

const addPolicy = (body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/v1/policies", headers: H, payload: { scope: {}, enabled: true, ...body } });

const queue = async () =>
  (await app.inject({ method: "GET", url: "/v1/approvals?status=pending", headers: H })).json() as Array<{ id: string; toolName: string }>;

const decide = (id: string, approve: boolean) =>
  app.inject({ method: "POST", url: `/v1/approvals/${id}/decide`, headers: H, payload: { approve, by: "operator" } });

describe("agent + SDK + control plane, end-to-end", () => {
  it("tool sensitif ASK → menunggu → jalan setelah di-approve dari dashboard", async () => {
    await addPolicy({
      name: "delete_file requires approval", type: "tool_permission", action: "ask",
      params: { tools: ["delete_file"], mode: "ask" },
    });

    const efekSamping: string[] = [];
    const deleteFile = curb.wrapTool(
      async (path: string) => {
        efekSamping.push(path);
        return `terhapus: ${path}`;
      },
      { name: "delete_file", sensitivity: "high" },
    );

    const agent = curb.run(async () => deleteFile("/tmp/penting.txt"), "run-e2e");

    // Tool masih ditahan; approval muncul di antrian dashboard.
    await vi.waitFor(async () => expect(await queue()).toHaveLength(1));
    expect(efekSamping).toEqual([]);

    const [pending] = await queue();
    expect(pending.toolName).toBe("delete_file");
    await decide(pending.id, true);

    expect(await agent).toBe("terhapus: /tmp/penting.txt");
    expect(efekSamping).toEqual(["/tmp/penting.txt"]);
  });

  it("deny dari dashboard → agent dapat PolicyViolation, tool tidak pernah jalan", async () => {
    await addPolicy({
      name: "delete_file requires approval", type: "tool_permission", action: "ask",
      params: { tools: ["delete_file"], mode: "ask" },
    });

    const efekSamping: string[] = [];
    const deleteFile = curb.wrapTool(async (p: string) => efekSamping.push(p), {
      name: "delete_file", sensitivity: "high",
    });

    const agent = curb.run(async () => deleteFile("/tmp/x"), "run-deny").catch((e) => e);
    await vi.waitFor(async () => expect(await queue()).toHaveLength(1));
    await decide((await queue())[0].id, false);

    const err = await agent;
    expect(err).toBeInstanceOf(PolicyViolation);
    expect(String(err)).toContain("operator");
    expect(efekSamping).toEqual([]);
  });

  it("policy mode deny langsung melempar tanpa approval", async () => {
    await addPolicy({
      name: "never touch the db", type: "tool_permission", action: "deny",
      params: { tools: ["wipe_db"], mode: "deny" },
    });
    const wipe = curb.wrapTool(async () => "boom", { name: "wipe_db" });
    await expect(curb.run(async () => wipe(), "run-deny2")).rejects.toThrow(PolicyViolation);
    expect(await queue()).toHaveLength(0);
  });

  it("step_limit menghentikan agent yang berputar", async () => {
    await addPolicy({ name: "max 3 steps", type: "step_limit", action: "deny", params: { maxSteps: 3 } });

    let langkah = 0;
    const jalan = curb.run(async () => {
      for (let i = 0; i < 10; i++) {
        await curb.step();
        langkah++;
      }
    }, "run-loop");

    await expect(jalan).rejects.toThrow(PolicyViolation);
    expect(langkah).toBe(3);
  });

  it("semua keputusan terekam di audit log", async () => {
    await addPolicy({ name: "max 1 step", type: "step_limit", action: "deny", params: { maxSteps: 1 } });
    await curb.run(async () => {
      await curb.step();
      await curb.step().catch(() => {});
    }, "run-audit");

    const events = (await app.inject({ method: "GET", url: "/v1/events?runId=run-audit", headers: H })).json();
    expect(events.map((e: { effect: string }) => e.effect)).toEqual(["DENY", "ALLOW"]);
  });
});
