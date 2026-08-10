import Fastify from "fastify";

/**
 * A fake, OpenAI-compatible LLM provider. It exists so the demo can run with no API key
 * and no real spend — Curb still meters tokens and usage exactly as it would in production.
 */
export async function startFakeProvider(port = 0) {
  const app = Fastify({ logger: false });

  app.post("/v1/chat/completions", async (req) => {
    const body = req.body as { messages?: Array<{ content?: string }>; stream?: boolean };
    const lastMessage = body.messages?.at(-1)?.content ?? "";
    return {
      id: `chatcmpl-palsu-${Date.now()}`,
      object: "chat.completion",
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: `reply to: ${lastMessage}` }, finish_reason: "stop" }],
      // 1000 in + 1000 out @ gpt-4o = $0.0125 per call
      usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 },
    };
  });

  await app.listen({ port, host: "127.0.0.1" });
  const addr = app.server.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`;
  return { url, close: () => app.close() };
}
