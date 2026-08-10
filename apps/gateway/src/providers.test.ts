import { describe, it, expect } from "vitest";
import {
  StreamUsageAccumulator,
  detectProvider,
  extractUsage,
  messagesOf,
  sanitizeHeaders,
} from "./providers.js";
import { PriceTable, DEFAULT_PRICING_PER_MTOK } from "./pricing.js";

describe("detectProvider", () => {
  it("mengenali Anthropic dari path", () => {
    expect(detectProvider("/v1/messages", {})).toBe("anthropic");
  });
  it("mengenali OpenAI dari path", () => {
    expect(detectProvider("/v1/chat/completions", {})).toBe("openai");
  });
  it("mengenali Anthropic dari header x-api-key", () => {
    expect(detectProvider("/v1/complete", { "x-api-key": "sk-ant" })).toBe("anthropic");
  });
  it("header x-curb-provider menang atas tebakan path", () => {
    expect(detectProvider("/v1/messages", { "x-curb-provider": "openai" })).toBe("openai");
  });
});

describe("sanitizeHeaders", () => {
  it("membuang header Curb dan hop-by-hop, menyisakan kredensial", () => {
    const out = sanitizeHeaders({
      "x-curb-run-id": "r1",
      "x-curb-key": "rahasia",
      host: "gw.curb.dev",
      "content-length": "42",
      connection: "keep-alive",
      authorization: "Bearer sk-user",
      "anthropic-version": "2023-06-01",
    });
    expect(out).toEqual({ authorization: "Bearer sk-user", "anthropic-version": "2023-06-01" });
  });
});

describe("extractUsage", () => {
  it("format OpenAI", () => {
    expect(extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
      .toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });
  it("format Anthropic", () => {
    expect(extractUsage({ usage: { input_tokens: 10, output_tokens: 5 } }))
      .toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });
  it("token cache ikut dihitung sebagai input", () => {
    expect(extractUsage({ usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } }).promptTokens)
      .toBe(100);
  });
  it("tanpa usage → nol", () => {
    expect(extractUsage({}).totalTokens).toBe(0);
    expect(extractUsage(null).totalTokens).toBe(0);
  });
});

describe("messagesOf", () => {
  it("system prompt Anthropic ikut masuk signature", () => {
    const a = messagesOf({ system: "kamu robot", messages: [{ role: "user", content: "hai" }] });
    const b = messagesOf({ system: "kamu manusia", messages: [{ role: "user", content: "hai" }] });
    expect(a).not.toEqual(b);
  });
});

describe("StreamUsageAccumulator", () => {
  it("membaca usage dari chunk terakhir OpenAI", () => {
    const acc = new StreamUsageAccumulator();
    acc.push('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
    acc.push('data: {"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\ndata: [DONE]\n\n');
    expect(acc.result()).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120 });
  });

  it("membaca usage bertahap ala Anthropic", () => {
    const acc = new StreamUsageAccumulator();
    acc.push('data: {"type":"message_start","message":{"usage":{"input_tokens":50,"output_tokens":1}}}\n\n');
    acc.push('data: {"type":"message_delta","usage":{"output_tokens":30}}\n\n');
    expect(acc.result()).toEqual({ promptTokens: 50, completionTokens: 30, totalTokens: 80 });
  });

  it("tahan terhadap chunk yang terpotong di tengah baris", () => {
    const acc = new StreamUsageAccumulator();
    const line = 'data: {"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n';
    for (const ch of line) acc.push(ch); // byte demi byte
    expect(acc.result().totalTokens).toBe(10);
  });

  it("mengabaikan baris non-JSON tanpa melempar", () => {
    const acc = new StreamUsageAccumulator();
    acc.push(": keep-alive\n\ndata: bukan-json\n\n");
    expect(acc.result().totalTokens).toBe(0);
  });
});

describe("PriceTable", () => {
  const t = new PriceTable(DEFAULT_PRICING_PER_MTOK);

  it("menghitung biaya per juta token", () => {
    // gpt-4o: $2.5 in / $10 out per Mtok
    expect(t.costUsd("gpt-4o", { promptTokens: 1e6, completionTokens: 0 })).toBeCloseTo(2.5, 6);
    expect(t.costUsd("gpt-4o", { promptTokens: 0, completionTokens: 1e6 })).toBeCloseTo(10, 6);
  });

  it("mencocokkan model bertanggal lewat prefix terpanjang", () => {
    expect(t.priceFor("gpt-4o-mini-2024-07-18")).toEqual(t.priceFor("gpt-4o-mini"));
    expect(t.priceFor("gpt-4o-2024-08-06")).toEqual(t.priceFor("gpt-4o"));
  });

  it("model tak dikenal memakai default yang sengaja mahal (fail-safe)", () => {
    const unknown = t.priceFor("model-antah-berantah");
    expect(unknown.in).toBeGreaterThan(t.priceFor("gpt-4o-mini").in);
    expect(t.has("model-antah-berantah")).toBe(false);
  });

  it("bisa di-override lewat konstruktor", () => {
    const custom = new PriceTable({ "gpt-4o": { in: 1, out: 1 }, default: { in: 1, out: 1 } });
    expect(custom.costUsd("gpt-4o", { promptTokens: 1e6, completionTokens: 0 })).toBeCloseTo(1, 6);
  });
});
