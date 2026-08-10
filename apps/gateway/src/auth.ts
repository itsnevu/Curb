import { createHash, timingSafeEqual } from "node:crypto";

export interface GatewayIdentity {
  projectId?: string;
}

export type Authenticator = (key: string | string[] | undefined) => GatewayIdentity | null;

/**
 * A header can arrive more than once — most often because the caller set `x-curb-key`
 * by hand AND spread `curb.gatewayHeaders()`, which sets it too. HTTP joins repeats with
 * commas, so the raw value becomes "key, key" and a naive comparison rejects a perfectly
 * valid request. Split it back apart and try each candidate.
 */
export function presentedKeys(header: string | string[] | undefined): string[] {
  if (header === undefined) return [];
  const raw = Array.isArray(header) ? header : [header];
  return raw
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Constant-time comparison of two secrets of any length.
 * Hashing first keeps the comparison at a fixed width — timingSafeEqual throws on a
 * length mismatch, and that throw itself would leak the length of the real key.
 */
export function secretsMatch(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * The gateway's authenticator: a request must carry a key we know.
 *
 * why this matters more than it looks: the gateway used to trust `X-Curb-Project` and
 * `X-Curb-Run-Id` straight off the wire. An agent could escape any project-scoped
 * policy by inventing a project id. The project now comes from the KEY, never from a
 * header the caller controls.
 */
export function keyAuthenticator(keys: Array<{ key: string; projectId?: string }>): Authenticator {
  return (presented) => {
    const candidates = presentedKeys(presented);
    if (candidates.length === 0) return null;
    const hit = keys.find((k) => k.key && candidates.some((c) => secretsMatch(k.key, c)));
    return hit ? { projectId: hit.projectId } : null;
  };
}

/** Anonymous access — dev and tests only. Never selected unless explicitly asked for. */
export const ALLOW_ANONYMOUS: Authenticator = () => ({});
