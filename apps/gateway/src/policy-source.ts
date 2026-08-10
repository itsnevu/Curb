import { readFileSync } from "node:fs";
import { request } from "undici";
import { PolicySchema, type Policy } from "@curb/shared";

/**
 * Dari mana gateway mengambil policy.
 * Urutan: control-plane (kalau CONTROL_PLANE_URL diset) → file → env inline → kosong.
 * Cache last-known-good supaya control-plane yang sekejap down tidak langsung
 * mematikan semua agent (fail-closed baru berlaku kalau cache pun tidak ada).
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

  /** @throws kalau tidak ada policy yang bisa dipercaya (caller menerapkan fail mode). */
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
  // Policy yang tidak valid dibuang (bukan menjatuhkan semuanya), tapi dicatat
  // oleh caller lewat selisih jumlah.
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
    // biarkan kosong; tanpa policy gateway hanya meneruskan (tidak ada aturan = tidak ada larangan)
  }
  return [];
}
