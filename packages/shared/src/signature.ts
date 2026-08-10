import { createHash } from "node:crypto";

/**
 * A stable signature of a conversation, used for loop detection.
 *
 * Only role and content survive, so ids and timestamps cannot make two identical
 * conversations look different. The digest is truncated because it is compared for
 * equality inside a small window, never used as a security primitive.
 */
export function signatureOf(messages: unknown): string {
  if (!Array.isArray(messages)) return "none";
  const norm = messages.map((m) => {
    const msg = m as { role?: unknown; content?: unknown };
    return {
      role: msg?.role,
      content: typeof msg?.content === "string" ? msg.content : JSON.stringify(msg?.content),
    };
  });
  return hashOf(norm);
}

/** Signature of anything at all — the SDK uses it to describe a step or a tool sequence. */
export function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 16);
}
