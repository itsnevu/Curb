import type { Context, Decision } from "@curb/shared";

export class PolicyViolation extends Error {
  constructor(public decision: Decision) {
    super(decision.reason ?? "policy violation");
    this.name = "PolicyViolation";
  }
}

export interface CurbOptions {
  baseUrl?: string; // control-plane, default http://localhost:8090
  apiKey?: string;
  runId?: string;
  pollMs?: number; // interval polling approval
}

/**
 * SDK guard — enforcement point untuk TOOL CALL (guardrail).
 * Contoh:
 *   const curb = new Curb({ runId });
 *   const safeDelete = curb.wrapTool(deleteFile, { name: "delete_file", sensitivity: "high" });
 */
export class Curb {
  private base: string;
  constructor(private opts: CurbOptions = {}) {
    this.base = opts.baseUrl ?? "http://localhost:8090";
  }

  async decide(ctx: Context): Promise<Decision & { approvalId?: string }> {
    const res = await fetch(`${this.base}/v1/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-curb-key": this.opts.apiKey ?? "" },
      body: JSON.stringify({ runId: this.opts.runId, ...ctx }),
    });
    return res.json();
  }

  /** Bungkus tool sync/async; tahan/deny sesuai policy sebelum eksekusi. */
  wrapTool<A extends any[], R>(
    fn: (...args: A) => R | Promise<R>,
    meta: { name: string; sensitivity?: "low" | "medium" | "high" },
  ) {
    return async (...args: A): Promise<R> => {
      const d = await this.decide({
        kind: "tool_call",
        runId: this.opts.runId ?? "run",
        toolName: meta.name,
        sensitivity: meta.sensitivity,
        toolArgs: args,
      });
      if (d.effect === "DENY") throw new PolicyViolation(d);
      if (d.effect === "ASK" && d.approvalId) {
        const ok = await this.waitApproval(d.approvalId);
        if (!ok) throw new PolicyViolation({ ...d, effect: "DENY", reason: "approval ditolak" });
      }
      return fn(...args);
    };
  }

  private async waitApproval(id: string): Promise<boolean> {
    const poll = this.opts.pollMs ?? 1500;
    // TODO: timeout & webhook alih-alih polling terus.
    for (;;) {
      const a = await (await fetch(`${this.base}/v1/approvals/${id}`)).json();
      if (a.status === "approved") return true;
      if (a.status === "denied") return false;
      await new Promise((r) => setTimeout(r, poll));
    }
  }
}
