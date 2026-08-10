import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Context } from "@curb/shared";
import { CurbClient, type ClientOptions, type DecisionResponse } from "./client.js";
import { ApprovalTimeout, PolicyViolation } from "./errors.js";

export * from "./errors.js";
export { CurbClient } from "./client.js";
export type { ClientOptions, DecisionResponse, ApprovalView } from "./client.js";

export interface CurbOptions extends ClientOptions {
  /** Used when not inside a run(). */
  runId?: string;
  projectId?: string;
  env?: string;
  /** How long to wait for a human to approve. Defaults to 5 minutes. */
  approvalTimeoutMs?: number;
  /** What happens when Curb is unreachable. Defaults to "closed" (deny). */
  failMode?: "open" | "closed";
  onDecision?: (d: DecisionResponse, ctx: Context) => void;
}

export interface ToolMeta {
  name: string;
  sensitivity?: "low" | "medium" | "high";
  /** Approval timeout specific to this tool. */
  approvalTimeoutMs?: number;
}

/** runId flows automatically to any tool called inside run(). */
const runStore = new AsyncLocalStorage<{ runId: string }>();

export function currentRunId(): string | undefined {
  return runStore.getStore()?.runId;
}

/**
 * The enforcement point for TOOL CALLS — the thing a proxy fundamentally cannot do.
 *
 *   const curb = new Curb();
 *   const remove = curb.wrapTool(deleteFile, { name: "delete_file", sensitivity: "high" });
 *   await curb.run(async () => { await remove("/tmp/x"); });
 */
export class Curb {
  private client: CurbClient;

  constructor(private opts: CurbOptions = {}) {
    this.client = new CurbClient(opts);
  }

  /** Run an agent inside one run: a runId is created, propagated, and returned. */
  async run<T>(fn: (runId: string) => Promise<T> | T, runId = this.opts.runId ?? randomUUID()): Promise<T> {
    return runStore.run({ runId }, async () => fn(runId));
  }

  /** The active runId — passed to the gateway via the X-Curb-Run-Id header. */
  runId(): string {
    return currentRunId() ?? this.opts.runId ?? "run-without-context";
  }

  /** Headers to attach to your LLM client so cost and loops are caught by the gateway. */
  gatewayHeaders(): Record<string, string> {
    return { "X-Curb-Run-Id": this.runId() };
  }

  /** Report one agent step — enforces step_limit, time_limit and loop_detect. */
  async step(meta: Record<string, unknown> = {}): Promise<void> {
    await this.enforce({ kind: "step", runId: this.runId(), meta });
  }

  /**
   * Wrap a tool. Before it executes, the policy engine is consulted:
   * ALLOW → run · DENY → PolicyViolation · ASK → hold until a human decides.
   */
  wrapTool<A extends unknown[], R>(fn: (...args: A) => R | Promise<R>, meta: ToolMeta) {
    const wrapped = async (...args: A): Promise<R> => {
      await this.enforce(
        {
          kind: "tool_call",
          runId: this.runId(),
          toolName: meta.name,
          sensitivity: meta.sensitivity,
          toolArgs: args,
        },
        meta,
      );
      return fn(...args);
    };
    Object.defineProperty(wrapped, "name", { value: `curb(${meta.name})` });
    return wrapped;
  }

  /** Wrap many tools at once: { name: fn } → { name: guarded fn }. */
  wrapTools<T extends Record<string, (...args: never[]) => unknown>>(
    tools: T,
    meta: Record<keyof T, Omit<ToolMeta, "name">> | Omit<ToolMeta, "name"> = {},
  ): T {
    const per = (k: string) =>
      (meta as Record<string, Omit<ToolMeta, "name">>)[k] ?? (meta as Omit<ToolMeta, "name">);
    return Object.fromEntries(
      Object.entries(tools).map(([k, fn]) => [
        k,
        this.wrapTool(fn as (...a: unknown[]) => unknown, { name: k, ...per(k) }),
      ]),
    ) as unknown as T;
  }

  /** Ask for a decision without wrapping anything. */
  async decide(ctx: Partial<Context> & Pick<Context, "kind">): Promise<DecisionResponse> {
    return this.ask({ runId: this.runId(), ...ctx } as Context);
  }

  private async ask(ctx: Context): Promise<DecisionResponse> {
    const full: Context = { projectId: this.opts.projectId, env: this.opts.env, ...ctx };
    try {
      const d = await this.client.decide(full);
      this.opts.onDecision?.(d, full);
      return d;
    } catch (err) {
      // why: an unreachable control plane means we cannot know whether this action is
      // safe. Fail closed by default: halting beats acting blind.
      if (this.opts.failMode === "open") {
        return { effect: "ALLOW", reason: `curb unreachable (fail-open): ${(err as Error).message}` };
      }
      return {
        effect: "DENY",
        policyId: "curb_unreachable",
        reason: `curb unreachable (fail-closed): ${(err as Error).message}`,
      };
    }
  }

  private async enforce(ctx: Context, meta?: ToolMeta): Promise<void> {
    const decision = await this.ask(ctx);
    if (decision.effect === "DENY") throw new PolicyViolation(decision, meta?.name);
    if (decision.effect === "THROTTLE" && decision.retryAfterMs) {
      await sleep(decision.retryAfterMs);
    }
    if (decision.effect !== "ASK") return;

    if (!decision.approvalId) {
      throw new PolicyViolation(
        { ...decision, effect: "DENY", reason: "ASK without approvalId — inconsistent control plane" },
        meta?.name,
      );
    }
    await this.awaitApproval(decision.approvalId, meta);
  }

  /** Long-poll repeatedly until a decision arrives or the total budget runs out. */
  private async awaitApproval(approvalId: string, meta?: ToolMeta): Promise<void> {
    const budget = meta?.approvalTimeoutMs ?? this.opts.approvalTimeoutMs ?? 5 * 60_000;
    const deadline = Date.now() + budget;

    while (Date.now() < deadline) {
      const slice = Math.min(30_000, deadline - Date.now());
      const startedAt = Date.now();
      let view;
      try {
        view = await this.client.waitApproval(approvalId, slice);
      } catch {
        // the long-poll connection dropped (proxy or network timeout) — retry while time remains
        await sleep(Math.min(1_000, Math.max(0, deadline - Date.now())));
        continue;
      }
      if (view.status === "approved") return;
      if (view.status === "denied" || view.status === "expired") {
        throw new PolicyViolation(
          {
            effect: "DENY",
            policyId: "curb_approval_denied",
            reason: `approval denied${view.decidedBy ? ` by ${view.decidedBy}` : ""}`,
          },
          meta?.name,
        );
      }
      // why: if the server replies instantly (no ?wait support), without this pause the
      // loop becomes a busy-poll that hammers the server AND starves this process's
      // timers, because it never leaves the microtask queue.
      const elapsed = Date.now() - startedAt;
      if (elapsed < slice) await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
    }

    if (this.opts.failMode === "open") return; // fail-open: proceed even with no answer
    throw new ApprovalTimeout(approvalId, budget, meta?.name);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
