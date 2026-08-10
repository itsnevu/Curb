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
  it("detects Anthropic from the path", () => {
    expect(detectProvider("/v1/messages", {})).toBe("anthropic");
  });
  it("detects OpenAI from the path", () => {
    expect(detectProvider("/v1/chat/completions", {})).toBe("openai");
  });
  it("detects Anthropic from the x-api-key header", () => {
    expect(detectProvider("/v1/complete", { "x-api-key": "sk-ant" })).toBe("anthropic");
  });
  it("the x-curb-provider header beats the path guess", () => {
    expect(detectProvider("/v1/messages", { "x-curb-provider": "openai" })).toBe("openai");
  });
});

describe("sanitizeHeaders", () => {
  it("strips Curb and hop-by-hop headers, keeps credentials", () => {
    const out = sanitizeHeaders({
      "x-curb-run-id": "r1",
      "x-curb-key": "secret",
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
  it("OpenAI format", () => {
    expect(extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
      .toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });
  it("Anthropic format", () => {
    expect(extractUsage({ usage: { input_tokens: 10, output_tokens: 5 } }))
      .toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });
  it("cached tokens count as input", () => {
    expect(extractUsage({ usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } }).promptTokens)
      .toBe(100);
  });
  it("no usage → zero", () => {
    expect(extractUsage({}).totalTokens).toBe(0);
    expect(extractUsage(null).totalTokens).toBe(0);
  });
});

describe("messagesOf", () => {
  it("the Anthropic system prompt is part of the signature", () => {
    const a = messagesOf({ system: "you are a robot", messages: [{ role: "user", content: "hi" }] });
    const b = messagesOf({ system: "you are a human", messages: [{ role: "user", content: "hi" }] });
    expect(a).not.toEqual(b);
  });
});

describe("StreamUsageAccumulator", () => {
  it("reads usage from the final OpenAI chunk", () => {
    const acc = new StreamUsageAccumulator();
    acc.push('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
    acc.push('data: {"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\ndata: [DONE]\n\n');
    expect(acc.result()).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120 });
  });

  it("reads usage incrementally, Anthropic style", () => {
    const acc = new StreamUsageAccumulator();
    acc.push('data: {"type":"message_start","message":{"usage":{"input_tokens":50,"output_tokens":1}}}\n\n');
    acc.push('data: {"type":"message_delta","usage":{"output_tokens":30}}\n\n');
    expect(acc.result()).toEqual({ promptTokens: 50, completionTokens: 30, totalTokens: 80 });
  });

  it("tolerates chunks split mid-line", () => {
    const acc = new StreamUsageAccumulator();
    const line = 'data: {"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n';
    for (const ch of line) acc.push(ch); // byte by byte
    expect(acc.result().totalTokens).toBe(10);
  });

  it("ignores non-JSON lines without throwing", () => {
    const acc = new StreamUsageAccumulator();
    acc.push(": keep-alive\n\ndata: bukan-json\n\n");
    expect(acc.result().totalTokens).toBe(0);
  });
});

describe("PriceTable", () => {
  const t = new PriceTable(DEFAULT_PRICING_PER_MTOK);

  it("prices per million tokens", () => {
    // gpt-4o: $2.5 in / $10 out per Mtok
    expect(t.costUsd("gpt-4o", { promptTokens: 1e6, completionTokens: 0 })).toBeCloseTo(2.5, 6);
    expect(t.costUsd("gpt-4o", { promptTokens: 0, completionTokens: 1e6 })).toBeCloseTo(10, 6);
  });

  it("matches dated models by longest prefix", () => {
    expect(t.priceFor("gpt-4o-mini-2024-07-18")).toEqual(t.priceFor("gpt-4o-mini"));
    expect(t.priceFor("gpt-4o-2024-08-06")).toEqual(t.priceFor("gpt-4o"));
  });

  it("unknown models use the deliberately expensive default (fail-safe)", () => {
    const unknown = t.priceFor("some-unknown-model");
    expect(unknown.in).toBeGreaterThan(t.priceFor("gpt-4o-mini").in);
    expect(t.has("some-unknown-model")).toBe(false);
  });

  it("can be overridden via the constructor", () => {
    const custom = new PriceTable({ "gpt-4o": { in: 1, out: 1 }, default: { in: 1, out: 1 } });
    expect(custom.costUsd("gpt-4o", { promptTokens: 1e6, completionTokens: 0 })).toBeCloseTo(1, 6);
  });
});
