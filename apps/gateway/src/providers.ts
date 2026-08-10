export type Provider = "openai" | "anthropic";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export const ZERO_USAGE: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** Curb's own headers — these must never leak upstream to the provider. */
export const CURB_HEADERS = ["x-curb-run-id", "x-curb-key", "x-curb-project", "x-curb-provider"];

/** Hop-by-hop headers, plus ones undici must recompute itself. */
const STRIPPED = ["host", "content-length", "connection", "transfer-encoding", "accept-encoding"];

export function detectProvider(path: string, headers: Record<string, unknown>): Provider {
  const hinted = headers["x-curb-provider"];
  if (hinted === "anthropic" || hinted === "openai") return hinted;
  // why: the Anthropic Messages API uses /v1/messages, OpenAI uses /v1/chat/completions.
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

/** Extract usage from a non-streaming response of either provider. */
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

/** The messages used for the loop-detection signature — the shape differs per provider. */
export function messagesOf(body: Record<string, unknown> | undefined): unknown[] {
  if (!body) return [];
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  // Anthropic keeps the system prompt outside `messages`; include it so two runs
  // with different system prompts aren't treated as the same loop.
  return body.system ? [{ role: "system", content: body.system }, ...msgs] : msgs;
}

export function isStreaming(body: Record<string, unknown> | undefined): boolean {
  return body?.stream === true;
}

/** Rough token count from raw text. ~4 characters per token holds well enough for both providers. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Worst-case usage for a request we have not sent yet, used to price it BEFORE
 * forwarding. Deliberately pessimistic: the prompt is measured for real, and the
 * completion is assumed to run to `max_tokens`. A cap that under-estimates is not a cap,
 * so when `max_tokens` is absent we assume a large-but-plausible completion.
 */
const ASSUMED_MAX_COMPLETION = 4096;

export function estimateUsage(body: Record<string, unknown> | undefined): Usage {
  if (!body) return ZERO_USAGE;
  const prompt = estimateTokens(JSON.stringify(messagesOf(body) ?? []));
  const asked = Number(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens);
  const completion = Number.isFinite(asked) && asked > 0 ? asked : ASSUMED_MAX_COMPLETION;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
}

/**
 * Accumulates usage from an SSE stream. Providers send usage in the final chunks:
 * - OpenAI: a chunk carrying `usage` (requires stream_options.include_usage)
 * - Anthropic: `message_start` (input) then `message_delta` (output)
 * Safe to feed arbitrary byte slices — it buffers until a line is complete.
 */
export class StreamUsageAccumulator {
  private buf = "";
  private usage: Usage = { ...ZERO_USAGE };

  push(chunk: string): void {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? ""; // trailing partial line
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
      return; // not JSON — ignore it rather than killing the stream
    }
    const direct = extractUsage(evt);
    const nested = extractUsage((evt as { message?: unknown }).message);
    for (const u of [direct, nested]) {
      // Anthropic sends cumulative usage per event, so take the LARGEST value to
      // avoid double counting; OpenAI sends it only once, where max() is a no-op.
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
