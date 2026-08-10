import { createHash } from "node:crypto";

/** A stable signature of the messages (volatile fields dropped) used for loop detection. */
export function signatureOf(messages: unknown): string {
  if (!Array.isArray(messages)) return "none";
  const norm = messages.map((m: any) => ({ role: m?.role, content: typeof m?.content === "string" ? m.content : JSON.stringify(m?.content) }));
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex").slice(0, 16);
}
