import type { Context, Decision } from "@curb/shared";

export interface ApprovalView {
  id: string;
  status: "pending" | "approved" | "denied" | "expired";
  toolName?: string;
  decidedBy?: string;
}

export type DecisionResponse = Decision & { approvalId?: string; runId?: string };

export type Fetcher = typeof fetch;

export interface ClientOptions {
  baseUrl?: string;
  apiKey?: string;
  /** Timeout for a single HTTP request (not how long we wait for an approval). */
  requestTimeoutMs?: number;
  fetch?: Fetcher;
}

/** A thin wrapper over the Decision and Approval APIs. Holds no state. */
export class CurbClient {
  private base: string;
  private apiKey: string;
  private timeout: number;
  private doFetch: Fetcher;

  constructor(opts: ClientOptions = {}) {
    this.base = (opts.baseUrl ?? process.env.CURB_URL ?? "http://localhost:8090").replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? process.env.CURB_API_KEY ?? "";
    this.timeout = opts.requestTimeoutMs ?? 10_000;
    this.doFetch = opts.fetch ?? ((...a) => fetch(...a));
  }

  async decide(ctx: Context): Promise<DecisionResponse> {
    return this.json<DecisionResponse>("POST", "/v1/decisions", ctx, this.timeout);
  }

  /**
   * Long-poll: the server holds the connection until a decision arrives or `waitMs`
   * elapses. The HTTP timeout is deliberately looser than waitMs so we are never the
   * side that hangs up first.
   */
  async waitApproval(id: string, waitMs: number): Promise<ApprovalView> {
    return this.json<ApprovalView>("GET", `/v1/approvals/${id}?wait=${waitMs}`, undefined, waitMs + 5_000);
  }

  async getApproval(id: string): Promise<ApprovalView> {
    return this.json<ApprovalView>("GET", `/v1/approvals/${id}`, undefined, this.timeout);
  }

  private async json<T>(method: string, path: string, body: unknown, timeoutMs: number): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.doFetch(`${this.base}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-curb-key": this.apiKey },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`curb ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
