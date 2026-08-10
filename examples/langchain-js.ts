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
  // Cost and loops: just point the base URL at the gateway.
  const llm = new ChatOpenAI({
    model: "gpt-4o",
    configuration: { baseURL: "http://localhost:8080/v1", defaultHeaders: curb.gatewayHeaders() },
  });

  // Guardrail: wrap the tool function, not the agent.
  const sendEmail = curb.wrapTool(
    async ({ to, body }: { to: string; body: string }) => `email sent to ${to}`,
    { name: "send_email", sensitivity: "high" },
  );

  const agent = createReactAgent({
    llm,
    tools: [
      new DynamicStructuredTool({
        name: "send_email",
        description: "Send an email to someone",
        schema: z.object({ to: z.string(), body: z.string() }),
        func: sendEmail, // ← ASK first, then send
      }),
    ],
  });

  const result = await agent.invoke({ messages: [{ role: "user", content: "Let the team know about the incident." }] });
  console.log(result.messages.at(-1)?.content);
});
