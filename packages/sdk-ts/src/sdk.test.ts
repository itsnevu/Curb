import { describe, it, expect, beforeEach, vi } from "vitest";
import { Curb, PolicyViolation, ApprovalTimeout, currentRunId } from "./index.js";
import type { DecisionResponse } from "./client.js";

/**
 * A fake control plane: we control the decision and the approval timing so the
 * waiting behaviour can be tested without a real server.
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
    throw new Error(`unexpected url: ${u}`);
  }) as unknown as typeof fetch;
  return { doFetch, seen };
}

const jsonRes = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

const curbWith = (server: ReturnType<typeof fakeServer>, over = {}) =>
  new Curb({ fetch: server.doFetch, apiKey: "k", ...over });

describe("run() and runId propagation", () => {
  it("creates a runId and propagates it to tools inside", async () => {
    const server = fakeServer({ decision: { effect: "ALLOW" } });
    const curb = curbWith(server);
    const tool = curb.wrapTool(async () => "result", { name: "read" });

    const runId = await curb.run(async (id) => {
      await tool();
      expect(currentRunId()).toBe(id);
      return id;
    });

    expect(server.seen[0].runId).toBe(runId);
  });

  it("a runId can be supplied explicitly", async () => {
    const server = fakeServer({ decision: { effect: "ALLOW" } });
    const curb = curbWith(server);
    await curb.run(async () => curb.wrapTool(async () => 1, { name: "t" })(), "run-mine");
    expect(server.seen[0].runId).toBe("run-mine");
  });

  it("gatewayHeaders carries the active runId to the gateway", async () => {
    const curb = curbWith(fakeServer({ decision: { effect: "ALLOW" } }));
    const headers = await curb.run(async () => curb.gatewayHeaders(), "run-x");
    expect(headers).toEqual({ "X-Curb-Run-Id": "run-x" });
  });

  it("two parallel runs do not swap runIds", async () => {
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
  it("ALLOW → the tool really runs, with its original arguments", async () => {
    const curb = curbWith(fakeServer({ decision: { effect: "ALLOW" } }));
    const fn = vi.fn(async (a: number, b: number) => a + b);
    expect(await curb.wrapTool(fn, { name: "add" })(2, 3)).toBe(5);
    expect(fn).toHaveBeenCalledWith(2, 3);
  });

  it("DENY → PolicyViolation and the tool does NOT run", async () => {
    const server = fakeServer({ decision: { effect: "DENY", policyId: "tp", reason: "dilarang" } });
    const fn = vi.fn(async () => "boom");
    const tool = curbWith(server).wrapTool(fn, { name: "wipe_db" });

    await expect(tool()).rejects.toThrow(PolicyViolation);
    await expect(tool()).rejects.toThrow("dilarang");
    expect(fn).not.toHaveBeenCalled();
  });

  it("PolicyViolation carries policyId and tool name", async () => {
    const server = fakeServer({ decision: { effect: "DENY", policyId: "tp" } });
    const err = await curbWith(server).wrapTool(async () => 1, { name: "wipe_db" })().catch((e) => e);
    expect(err).toMatchObject({ policyId: "tp", toolName: "wipe_db" });
  });

  it("sends sensitivity and tool name to the Decision API", async () => {
    const server = fakeServer({ decision: { effect: "ALLOW" } });
    await curbWith(server).wrapTool(async () => 1, { name: "delete_file", sensitivity: "high" })();
    expect(server.seen[0]).toMatchObject({ kind: "tool_call", toolName: "delete_file", sensitivity: "high" });
  });

  it("wrapTools guards several tools at once", async () => {
    const server = fakeServer({ decision: { effect: "ALLOW" } });
    const tools = curbWith(server).wrapTools({ read: async () => "a", write: async () => "b" }, { sensitivity: "high" });
    await tools.read();
    await tools.write();
    expect(server.seen.map((c) => c.toolName)).toEqual(["read", "write"]);
  });
});

describe("ask-before-acting", () => {
  it("waits, then runs once approved", async () => {
    let status: "pending" | "approved" = "pending";
    const server = fakeServer({
      decision: { effect: "ASK", approvalId: "apr_1", reason: "needs permission" },
      approvalStatus: () => status,
    });
    const fn = vi.fn(async () => "deleted");
    const tool = curbWith(server, { approvalTimeoutMs: 2_000 }).wrapTool(fn, { name: "delete_file" });

    const pending = tool();
    expect(fn).not.toHaveBeenCalled(); // still held
    setTimeout(() => { status = "approved"; }, 30);
    expect(await pending).toBe("deleted");
  });

  it("denied by a human → PolicyViolation", async () => {
    const server = fakeServer({
      decision: { effect: "ASK", approvalId: "apr_1" },
      approvalStatus: () => "denied",
    });
    const fn = vi.fn();
    await expect(curbWith(server).wrapTool(fn, { name: "delete_file" })()).rejects.toThrow(PolicyViolation);
    expect(fn).not.toHaveBeenCalled();
  });

  it("approval timeout → ApprovalTimeout (fail-closed)", async () => {
    const server = fakeServer({
      decision: { effect: "ASK", approvalId: "apr_1" },
      approvalStatus: () => "pending",
    });
    const tool = curbWith(server, { approvalTimeoutMs: 60 }).wrapTool(async () => 1, { name: "delete_file" });
    await expect(tool()).rejects.toThrow(ApprovalTimeout);
  });

  it("approval timeout with failMode open → still runs", async () => {
    const server = fakeServer({
      decision: { effect: "ASK", approvalId: "apr_1" },
      approvalStatus: () => "pending",
    });
    const tool = curbWith(server, { approvalTimeoutMs: 60, failMode: "open" })
      .wrapTool(async () => "ran", { name: "delete_file" });
    expect(await tool()).toBe("ran");
  });

  it("ASK without an approvalId counts as DENY, not a silent pass", async () => {
    const server = fakeServer({ decision: { effect: "ASK" } });
    await expect(curbWith(server).wrapTool(async () => 1, { name: "t" })()).rejects.toThrow(PolicyViolation);
  });
});

describe("fail mode when the control plane is down", () => {
  it("fail-closed (default) → the tool is denied", async () => {
    const server = fakeServer({ decision: { effect: "ALLOW" }, failDecide: true });
    const fn = vi.fn();
    await expect(curbWith(server).wrapTool(fn, { name: "t" })()).rejects.toThrow(/unreachable/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("fail-open → the tool still runs", async () => {
    const server = fakeServer({ decision: { effect: "ALLOW" }, failDecide: true });
    const tool = curbWith(server, { failMode: "open" }).wrapTool(async () => "ran", { name: "t" });
    expect(await tool()).toBe("ran");
  });
});

describe("step()", () => {
  it("reports steps and throws once step_limit is reached", async () => {
    let n = 0;
    const server = fakeServer({ decision: () => (++n > 2 ? { effect: "DENY", reason: "step_limit" } : { effect: "ALLOW" }) });
    const curb = curbWith(server);
    await curb.step();
    await curb.step();
    await expect(curb.step()).rejects.toThrow("step_limit");
  });

  it("onDecision is called for every decision", async () => {
    const seen: string[] = [];
    const server = fakeServer({ decision: { effect: "ALLOW" } });
    const curb = curbWith(server, { onDecision: (d: DecisionResponse) => seen.push(d.effect) });
    await curb.step();
    await curb.wrapTool(async () => 1, { name: "t" })();
    expect(seen).toEqual(["ALLOW", "ALLOW"]);
  });
});
