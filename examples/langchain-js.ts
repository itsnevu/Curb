/**
 * LangChain JS + Curb.
 * npm i langchain @langchain/openai @curb/sdk zod
 */
import { ChatOpenAI } from "@langchain/openai";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { Curb } from "@curb/sdk";

const curb = new Curb({ baseUrl: "http://localhost:8090", apiKey: process.env.CURB_API_KEY });

await curb.run(async () => {
  // Cost & loop: cukup arahkan base URL ke gateway.
  const llm = new ChatOpenAI({
    model: "gpt-4o",
    configuration: { baseURL: "http://localhost:8080/v1", defaultHeaders: curb.gatewayHeaders() },
  });

  // Guardrail: bungkus fungsi tool-nya, bukan agent-nya.
  const kirimEmail = curb.wrapTool(
    async ({ to, body }: { to: string; body: string }) => `email ke ${to} terkirim`,
    { name: "send_email", sensitivity: "high" },
  );

  const agent = createReactAgent({
    llm,
    tools: [
      new DynamicStructuredTool({
        name: "send_email",
        description: "Kirim email ke seseorang",
        schema: z.object({ to: z.string(), body: z.string() }),
        func: kirimEmail, // ← ASK dulu, baru kirim
      }),
    ],
  });

  const hasil = await agent.invoke({ messages: [{ role: "user", content: "Kabari tim soal insiden." }] });
  console.log(hasil.messages.at(-1)?.content);
});
