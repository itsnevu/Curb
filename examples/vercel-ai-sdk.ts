/**
 * Vercel AI SDK + Curb — cost/loops via the gateway, guardrails via the SDK.
 * npm i ai @ai-sdk/openai @curb/sdk
 */
import { openai, createOpenAI } from "@ai-sdk/openai";
import { generateText, tool } from "ai";
import { z } from "zod";
import { Curb } from "@curb/sdk";

const curb = new Curb({ baseUrl: "http://localhost:8090", apiKey: process.env.CURB_API_KEY });

await curb.run(async () => {
  // 1) Point the base URL at the gateway → automatic cost cap and loop detection,
  //    with no change to your agent logic.
  const model = createOpenAI({
    baseURL: "http://localhost:8080/v1",
    headers: curb.gatewayHeaders(), // attaches X-Curb-Run-Id
  })("gpt-4o");

  // 2) Wrap the dangerous tool → ASK/DENY before it executes.
  const remove = curb.wrapTool(async ({ path }: { path: string }) => `deleted ${path}`, {
    name: "delete_file",
    sensitivity: "high",
  });

  const { text } = await generateText({
    model,
    prompt: "Clean up temporary files in /tmp and report back.",
    tools: {
      delete_file: tool({
        description: "Delete a file",
        parameters: z.object({ path: z.string() }),
        execute: remove, // ← execution is held until a human approves
      }),
    },
    maxSteps: 5,
  });

  console.log(text);
});
