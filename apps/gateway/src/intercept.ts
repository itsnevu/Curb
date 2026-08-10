import { request } from "undici";

const UPSTREAM = process.env.OPENAI_UPSTREAM ?? "https://api.openai.com";

export async function forwardUpstream(url: string, headers: any, body: unknown) {
  const clean = { ...headers };
  delete clean["host"]; delete clean["content-length"];
  delete clean["x-curb-run-id"]; delete clean["x-curb-key"];
  const res = await request(`${UPSTREAM}${url}`, {
    method: "POST",
    headers: clean,
    body: JSON.stringify(body),
  });
  const json = await res.body.json();
  return { status: res.statusCode, json };
}

export function extractUsage(json: any): { promptTokens: number; completionTokens: number; totalTokens: number } {
  const u = json?.usage ?? {};
  const promptTokens = u.prompt_tokens ?? u.input_tokens ?? 0;
  const completionTokens = u.completion_tokens ?? u.output_tokens ?? 0;
  return { promptTokens, completionTokens, totalTokens: u.total_tokens ?? promptTokens + completionTokens };
}

// TODO(M1): tabel harga per-model yang bener & bisa dikonfigurasi.
const PRICE: Record<string, { in: number; out: number }> = {
  "gpt-4o": { in: 2.5 / 1e6, out: 10 / 1e6 },
  "gpt-4o-mini": { in: 0.15 / 1e6, out: 0.6 / 1e6 },
  default: { in: 1 / 1e6, out: 3 / 1e6 },
};

export function estimateCostUsd(model: string | undefined, u: { promptTokens: number; completionTokens: number }) {
  const p = PRICE[model ?? "default"] ?? PRICE.default;
  return u.promptTokens * p.in + u.completionTokens * p.out;
}
