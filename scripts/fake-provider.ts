import Fastify from "fastify";

/**
 * Provider LLM palsu yang OpenAI-compatible. Ada supaya demo bisa jalan tanpa
 * API key dan tanpa biaya sungguhan — Curb tetap melihat token & usage asli-asli saja.
 */
export async function startFakeProvider(port = 0) {
  const app = Fastify({ logger: false });

  app.post("/v1/chat/completions", async (req) => {
    const body = req.body as { messages?: Array<{ content?: string }>; stream?: boolean };
    const isi = body.messages?.at(-1)?.content ?? "";
    return {
      id: `chatcmpl-palsu-${Date.now()}`,
      object: "chat.completion",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: `balasan untuk: ${isi}` }, finish_reason: "stop" }],
      // 1000 in + 1000 out @ gpt-4o = $0.0125 per call
      usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 },
    };
  });

  await app.listen({ port, host: "127.0.0.1" });
  const addr = app.server.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`;
  return { url, close: () => app.close() };
}
