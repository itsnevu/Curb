import { createHash } from "node:crypto";

const SECRET_KEYS = /pass|secret|token|key|auth|credential|cookie|session/i;
const MAX_STRING = 120;

/**
 * Ringkas argumen tool untuk ditampilkan di antrian approval.
 * Manusia butuh cukup konteks untuk memutuskan ("hapus file APA?"), tapi
 * kita tidak boleh menyimpan rahasia. Nilai panjang dipotong, key yang
 * mencurigakan diganti hash pendek.
 */
export function digestArgs(args: unknown, depth = 0): Record<string, unknown> {
  const value = redact(args, depth);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

function redact(value: unknown, depth: number): unknown {
  if (depth > 4) return "[too deep]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const head = value.slice(0, 10).map((v) => redact(v, depth + 1));
    return value.length > 10 ? [...head, `…+${value.length - 10} more`] : head;
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 25)
        .map(([k, v]) => [k, SECRET_KEYS.test(k) ? fingerprint(v) : redact(v, depth + 1)]),
    );
  }
  return String(value);
}

function truncate(s: string): string {
  return s.length <= MAX_STRING ? s : `${s.slice(0, MAX_STRING)}… (${s.length} char)`;
}

/** Cukup untuk membandingkan dua nilai tanpa mengungkapkannya. */
export function fingerprint(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return `sha256:${createHash("sha256").update(s).digest("hex").slice(0, 12)}`;
}
