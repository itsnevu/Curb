import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Context } from "@curb/shared";
import { CurbClient, type ClientOptions, type DecisionResponse } from "./client.js";
import { ApprovalTimeout, PolicyViolation } from "./errors.js";

export * from "./errors.js";
export { CurbClient } from "./client.js";
export type { ClientOptions, DecisionResponse, ApprovalView } from "./client.js";

export interface CurbOptions extends ClientOptions {
  /** Dipakai kalau tidak sedang berada di dalam run(). */
  runId?: string;
  projectId?: string;
  env?: string;
  /** Berapa lama menunggu manusia menyetujui. Default 5 menit. */
  approvalTimeoutMs?: number;
  /** Apa yang terjadi kalau Curb tidak bisa dihubungi. Default "closed" (tolak). */
  failMode?: "open" | "closed";
  onDecision?: (d: DecisionResponse, ctx: Context) => void;
}

export interface ToolMeta {
  name: string;
  sensitivity?: "low" | "medium" | "high";
  /** Timeout approval khusus tool ini. */
  approvalTimeoutMs?: number;
}

/** runId mengalir otomatis ke tool yang dipanggil di dalam run(). */
const runStore = new AsyncLocalStorage<{ runId: string }>();

export function currentRunId(): string | undefined {
  return runStore.getStore()?.runId;
}

/**
 * Enforcement point untuk TOOL CALL — hal yang tidak bisa dilakukan proxy.
 *
 *   const curb = new Curb();
 *   const hapus = curb.wrapTool(deleteFile, { name: "delete_file", sensitivity: "high" });
 *   await curb.run(async () => { await hapus("/tmp/x"); });
 */
export class Curb {
  private client: CurbClient;

  constructor(private opts: CurbOptions = {}) {
    this.client = new CurbClient(opts);
  }

  /** Jalankan agent dalam satu run: runId dibuat, disebar, dan bisa dibaca ulang. */
  async run<T>(fn: (runId: string) => Promise<T> | T, runId = this.opts.runId ?? randomUUID()): Promise<T> {
    return runStore.run({ runId }, async () => fn(runId));
  }

  /** runId aktif — dipakai untuk mengoper ke gateway lewat header X-Curb-Run-Id. */
  runId(): string {
    return currentRunId() ?? this.opts.runId ?? "run-without-context";
  }

  /** Header yang perlu ditempel ke klien LLM supaya cost/loop ikut terjaring gateway. */
  gatewayHeaders(): Record<string, string> {
    return { "X-Curb-Run-Id": this.runId() };
  }

  /** Laporkan satu langkah agent — menegakkan step_limit / time_limit / loop_detect. */
  async step(meta: Record<string, unknown> = {}): Promise<void> {
    await this.enforce({ kind: "step", runId: this.runId(), meta });
  }

  /**
   * Bungkus tool. Sebelum tool dieksekusi, policy ditanya:
   * ALLOW → jalan · DENY → PolicyViolation · ASK → tahan sampai manusia memutuskan.
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

  /** Bungkus banyak tool sekaligus: { nama: fn } → { nama: fn terjaga }. */
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

  /** Minta keputusan tanpa membungkus apa pun. */
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
      // why: control plane tak terjangkau = kita tidak tahu apakah aksi ini aman.
      // Default fail-closed: lebih baik agent berhenti daripada bertindak buta.
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

  /** Long-poll berulang sampai diputuskan atau kehabisan waktu total. */
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
        // koneksi long-poll putus (proxy/timeout jaringan) — coba lagi selama masih ada waktu
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
      // why: kalau server balas cepat (tidak mendukung ?wait), tanpa jeda ini
      // loop berubah jadi busy-poll yang menghantam server DAN membuat timer
      // proses ini kelaparan karena tidak pernah keluar dari microtask.
      const elapsed = Date.now() - startedAt;
      if (elapsed < slice) await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
    }

    if (this.opts.failMode === "open") return; // fail-open: lanjut walau tak ada jawaban
    throw new ApprovalTimeout(approvalId, budget, meta?.name);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
