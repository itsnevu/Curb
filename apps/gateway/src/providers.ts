export type Provider = "openai" | "anthropic";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export const ZERO_USAGE: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** Header milik Curb — tidak boleh bocor ke provider. */
export const CURB_HEADERS = ["x-curb-run-id", "x-curb-key", "x-curb-project", "x-curb-provider"];

/** Header hop-by-hop / yang harus dihitung ulang oleh undici. */
const STRIPPED = ["host", "content-length", "connection", "transfer-encoding", "accept-encoding"];

export function detectProvider(path: string, headers: Record<string, unknown>): Provider {
  const hinted = headers["x-curb-provider"];
  if (hinted === "anthropic" || hinted === "openai") return hinted;
  // why: Anthropic Messages API pakai /v1/messages, OpenAI pakai /v1/chat/completions.
  if (path.includes("/messages")) return "anthropic";
  if (headers["x-api-key"] && !headers["authorization"]) return "anthropic";
  return "openai";
}

export function upstreamFor(provider: Provider): string {
  return provider === "anthropic"
    ? (process.env.ANTHROPIC_UPSTREAM ?? "https://api.anthropic.com")
    : (process.env.OPENAI_UPSTREAM ?? "https://api.openai.com");
}

export function sanitizeHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (STRIPPED.includes(key) || CURB_HEADERS.includes(key)) continue;
    if (typeof v === "string") out[key] = v;
    else if (Array.isArray(v)) out[key] = v.join(", ");
  }
  return out;
}

/** Ekstrak usage dari response non-streaming kedua provider. */
export function extractUsage(json: unknown): Usage {
  const u = (json as { usage?: Record<string, number> } | null)?.usage;
  if (!u) return ZERO_USAGE;
  const promptTokens = num(u.prompt_tokens) + num(u.input_tokens) + num(u.cache_read_input_tokens);
  const completionTokens = num(u.completion_tokens) + num(u.output_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: u.total_tokens ? num(u.total_tokens) : promptTokens + completionTokens,
  };
}

/** Pesan yang dipakai untuk signature loop-detect — bentuknya beda per provider. */
export function messagesOf(body: Record<string, unknown> | undefined): unknown[] {
  if (!body) return [];
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  // Anthropic menaruh system prompt di luar messages; ikut dihitung supaya
  // dua run dengan system berbeda tidak dianggap loop yang sama.
  return body.system ? [{ role: "system", content: body.system }, ...msgs] : msgs;
}

export function isStreaming(body: Record<string, unknown> | undefined): boolean {
  return body?.stream === true;
}

/**
 * Akumulator usage dari SSE. Provider mengirim usage di chunk terakhir:
 * - OpenAI: chunk dengan `usage` (butuh stream_options.include_usage)
 * - Anthropic: `message_start` (input) lalu `message_delta` (output)
 * Aman dipanggil per potongan byte sembarang — buffer sampai baris utuh.
 */
export class StreamUsageAccumulator {
  private buf = "";
  private usage: Usage = { ...ZERO_USAGE };

  push(chunk: string): void {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? ""; // sisa baris belum utuh
    for (const line of lines) this.consumeLine(line.trim());
  }

  private consumeLine(line: string): void {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(payload);
    } catch {
      return; // chunk bukan JSON — abaikan, jangan jatuhkan stream
    }
    const direct = extractUsage(evt);
    const nested = extractUsage((evt as { message?: unknown }).message);
    for (const u of [direct, nested]) {
      // Anthropic mengirim usage kumulatif per event; ambil nilai TERBESAR
      // supaya tidak dobel-hitung, sedangkan OpenAI hanya mengirim sekali.
      this.usage.promptTokens = Math.max(this.usage.promptTokens, u.promptTokens);
      this.usage.completionTokens = Math.max(this.usage.completionTokens, u.completionTokens);
    }
  }

  result(): Usage {
    return {
      ...this.usage,
      totalTokens: this.usage.promptTokens + this.usage.completionTokens,
    };
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
