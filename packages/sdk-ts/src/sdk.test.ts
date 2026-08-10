import { describe, it, expect, beforeEach, vi } from "vitest";
import { Curb, PolicyViolation, ApprovalTimeout, currentRunId } from "./index.js";
import type { DecisionResponse } from "./client.js";

/**
 * Control plane palsu: kita kendalikan keputusan & waktu approval,
 * supaya bisa menguji perilaku menunggu tanpa server sungguhan.
 */
function fakeServer(opts: {
  decision: DecisionResponse | ((ctx: Record<string, unknown>) => DecisionResponse);
  approvalStatus?: () => "pending" | "approved" | "denied";
  failDecide?: boolean;
}) {
  const seen: Record<string, unknown>[] = [];
  const doFetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/v1/decisions")) {
      if (opts.failDecide) throw new Error("ECONNREFUSED");
      const ctx = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen.push(ctx);
      const d = typeof opts.decision === "function" ? opts.decision(ctx) : opts.decision;
      return jsonRes(d);
    }
    if (u.includes("/v1/approvals/")) {
      return jsonRes({ id: "apr_1", status: opts.approvalStatus?.() ?? "pending" });
    }
    throw new Error(`url tak terduga: ${u}`);
  }) as unknown as typeof fetch;
  return { doFetch, seen };
}

const jsonRes = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

const curbWith = (server: ReturnType<typeof fakeServer>, over = {}) =>
  new Curb({ fetch: server.doFetch, apiKey: "k", ...over });

describe("run() & propagasi runId", () => {
  it("membuat runId dan menyebarkannya ke tool di dalamnya", async () => {
    const server = fakeServer({ decision: { effect: "ALLOW" } });
    const curb = curbWith(server);
    const tool = curb.wrapTool(async () => "hasil", { name: "baca" });

    const runId = await curb.run(async (id) => {
      await tool();
      expect(currentRunId()).toBe(id);
      return id;
    });

    expect(server.seen[0].runId).toBe(runId);
  });

  it("runId bisa ditentukan sendiri", async () => {
    const server = fakeServer({ decision: { effect: "ALLOW" } });
    const curb = curbWith(server);
    await curb.run(async () => curb.wrapTool(async () => 1, { name: "t" })(), "run-saya");
    expect(server.seen[0].runId).toBe("run-saya");
  });

  it("gatewayHeaders membawa runId aktif ke gateway", async () => {
    const curb = curbWith(fakeServer({ decision: { effect: "ALLOW" } }));
    const headers = await curb.run(async () => curb.gatewayHeaders(), "run-x");
    expect(headers).toEqual({ "X-Curb-Run-Id": "run-x" });
  });

  it("dua run paralel tidak tertukar runId-nya", async () => {
    const server = fakeServer({ decision: { effect: "ALLOW" } });
    const curb = curbWith(server);
    const tool = curb.wrapTool(async () => currentRunId(), { name: "t" });
    const [a, b] = await Promise.all([
      curb.run(async () => tool(), "run-a"),
      curb.run(async () => tool(), "run-b"),
    ]);
    expect([a, b]).toEqual(["run-a", "run-b"]);
  });
});

describe("wrapTool", () => {
  it("ALLOW → tool benar-benar dijalankan dengan argumen aslinya", async () => {
    const curb = curbWith(fakeServer({ decision: { effect: "ALLOW" } }));
    const fn = vi.fn(async (a: number, b: number) => a + b);
    expect(await curb.wrapTool(fn, { name: "tambah" })(2, 3)).toBe(5);
    expect(fn).toHaveBeenCalledWith(2, 3);
  });

  it("DENY → PolicyViolation dan tool TIDAK dijalankan", async () => {
    const server = fakeServer({ decision: { effect: "DENY", policyId: "tp", reason: "dilarang" } });
    const fn = vi.fn(async () => "boom");
    const tool = curbWith(server).wrapTool(fn, { name: "wipe_db" });

    await expect(tool()).rejects.toThrow(PolicyViolation);
    await expect(tool()).rejects.toThrow("dilarang");
    expect(fn).not.toHaveBeenCalled();
  });

  it("PolicyViolation membawa policyId & nama tool", async () => {
    const server = fakeServer({ decision: { effect: "DENY", policyId: "tp" } });
    const err = await curbWith(server).wrapTool(async () => 1, { name: "wipe_db" })().catch((e) => e);
    expect(err).toMatchObject({ policyId: "tp", toolName: "wipe_db" });
  });

  it("mengirim sensitivity dan nama tool ke Decision API", async () => {
    const server = fakeServer({ decision: { effect: "ALLOW" } });
    await curbWith(server).wrapTool(async () => 1, { name: "delete_file", sensitivity: "high" })();
    expect(server.seen[0]).toMatchObject({ kind: "tool_call", toolName: "delete_file", sensitivity: "high" });
  });

  it("wrapTools membungkus banyak tool sekaligus", async () => {
    const server = fakeServer({ decision: { effect: "ALLOW" } });
    const tools = curbWith(server).wrapTools({ baca: async () => "a", tulis: async () => "b" }, { sensitivity: "high" });
    await tools.baca();
    await tools.tulis();
    expect(server.seen.map((c) => c.toolName)).toEqual(["baca", "tulis"]);
  });
});

describe("ask-before-acting", () => {
  it("menunggu, lalu jalan setelah disetujui", async () => {
    let status: "pending" | "approved" = "pending";
    const server = fakeServer({
      decision: { effect: "ASK", approvalId: "apr_1", reason: "butuh izin" },
      approvalStatus: () => status,
    });
    const fn = vi.fn(async () => "terhapus");
    const tool = curbWith(server, { approvalTimeoutMs: 2_000 }).wrapTool(fn, { name: "delete_file" });

    const pending = tool();
    expect(fn).not.toHaveBeenCalled(); // masih ditahan
    setTimeout(() => { status = "approved"; }, 30);
    expect(await pending).toBe("terhapus");
  });

  it("ditolak manusia → PolicyViolation", async () => {
    const server = fakeServer({
      decision: { effect: "ASK", approvalId: "apr_1" },
      approvalStatus: () => "denied",
    });
    const fn = vi.fn();
    await expect(curbWith(server).wrapTool(fn, { name: "delete_file" })()).rejects.toThrow(PolicyViolation);
    expect(fn).not.toHaveBeenCalled();
  });

  it("timeout approval → ApprovalTimeout (fail-closed)", async () => {
    const server = fakeServer({
      decision: { effect: "ASK", approvalId: "apr_1" },
      approvalStatus: () => "pending",
    });
    const tool = curbWith(server, { approvalTimeoutMs: 60 }).wrapTool(async () => 1, { name: "delete_file" });
    await expect(tool()).rejects.toThrow(ApprovalTimeout);
  });

  it("timeout approval dengan failMode open → tetap jalan", async () => {
    const server = fakeServer({
      decision: { effect: "ASK", approvalId: "apr_1" },
      approvalStatus: () => "pending",
    });
    const tool = curbWith(server, { approvalTimeoutMs: 60, failMode: "open" })
      .wrapTool(async () => "jalan", { name: "delete_file" });
    expect(await tool()).toBe("jalan");
  });

  it("ASK tanpa approvalId dianggap DENY, bukan lolos diam-diam", async () => {
    const server = fakeServer({ decision: { effect: "ASK" } });
    await expect(curbWith(server).wrapTool(async () => 1, { name: "t" })()).rejects.toThrow(PolicyViolation);
  });
});

describe("fail mode saat control plane mati", () => {
  it("fail-closed (default) → tool ditolak", async () => {
    const server = fakeServer({ decision: { effect: "ALLOW" }, failDecide: true });
    const fn = vi.fn();
    await expect(curbWith(server).wrapTool(fn, { name: "t" })()).rejects.toThrow(/tidak terjangkau/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("fail-open → tool tetap jalan", async () => {
    const server = fakeServer({ decision: { effect: "ALLOW" }, failDecide: true });
    const tool = curbWith(server, { failMode: "open" }).wrapTool(async () => "jalan", { name: "t" });
    expect(await tool()).toBe("jalan");
  });
});

describe("step()", () => {
  it("melaporkan step dan melempar saat step_limit tercapai", async () => {
    let n = 0;
    const server = fakeServer({ decision: () => (++n > 2 ? { effect: "DENY", reason: "step_limit" } : { effect: "ALLOW" }) });
    const curb = curbWith(server);
    await curb.step();
    await curb.step();
    await expect(curb.step()).rejects.toThrow("step_limit");
  });

  it("onDecision dipanggil untuk tiap keputusan", async () => {
    const seen: string[] = [];
    const server = fakeServer({ decision: { effect: "ALLOW" } });
    const curb = curbWith(server, { onDecision: (d: DecisionResponse) => seen.push(d.effect) });
    await curb.step();
    await curb.wrapTool(async () => 1, { name: "t" })();
    expect(seen).toEqual(["ALLOW", "ALLOW"]);
  });
});
