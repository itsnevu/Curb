import { readFileSync } from "node:fs";
import { request } from "undici";
import { PolicySchema, type Policy } from "@curb/shared";

/**
 * Where the gateway gets its policies.
 * Order: control plane (if CONTROL_PLANE_URL is set) → file → inline env → empty.
 * Keeps a last-known-good cache so a brief control-plane outage doesn't immediately
 * halt every agent; fail-closed only kicks in when there is no cache either.
 */
export class PolicySource {
  private cache: Policy[] | null = null;
  private fetchedAt = 0;

  constructor(
    private opts: {
      controlPlaneUrl?: string;
      apiKey?: string;
      ttlMs?: number;
      now?: () => number;
    } = {},
  ) {}

  private get ttl() {
    return this.opts.ttlMs ?? 5_000;
  }
  private nowMs(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** @throws when no trustworthy policy set is available; the caller applies the fail mode. */
  async load(): Promise<Policy[]> {
    if (this.cache && this.nowMs() - this.fetchedAt < this.ttl) return this.cache;

    const url = this.opts.controlPlaneUrl;
    if (!url) {
      const local = loadLocalPolicies();
      this.put(local);
      return local;
    }

    try {
      const res = await request(`${url.replace(/\/$/, "")}/v1/policies`, {
        method: "GET",
        headers: { "x-curb-key": this.opts.apiKey ?? "" },
        headersTimeout: 2_000,
        bodyTimeout: 2_000,
      });
      if (res.statusCode >= 400) throw new Error(`control-plane ${res.statusCode}`);
      const body = (await res.body.json()) as unknown;
      const parsed = parsePolicies(body);
      this.put(parsed);
      return parsed;
    } catch (err) {
      if (this.cache) return this.cache; // last-known-good
      throw err;
    }
  }

  private put(policies: Policy[]) {
    this.cache = policies;
    this.fetchedAt = this.nowMs();
  }
}

export function parsePolicies(body: unknown): Policy[] {
  const raw = Array.isArray(body) ? body : ((body as { policies?: unknown[] })?.policies ?? []);
  // Drop individual invalid policies rather than rejecting the whole set;
  // the caller can notice via the difference in count.
  return raw.flatMap((p) => {
    const parsed = PolicySchema.safeParse(p);
    return parsed.success ? [parsed.data] : [];
  });
}

function loadLocalPolicies(): Policy[] {
  try {
    if (process.env.CURB_POLICIES) return parsePolicies(JSON.parse(process.env.CURB_POLICIES));
    if (process.env.CURB_POLICIES_FILE) {
      return parsePolicies(JSON.parse(readFileSync(process.env.CURB_POLICIES_FILE, "utf8")));
    }
  } catch {
    // leave it empty; with no policies the gateway simply forwards (no rules, no restrictions)
  }
  return [];
}
