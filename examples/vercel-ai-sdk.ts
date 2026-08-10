/**
 * Vercel AI SDK + Curb — cost/loop lewat gateway, guardrail lewat SDK.
 * npm i ai @ai-sdk/openai @curb/sdk
 */
import { openai, createOpenAI } from "@ai-sdk/openai";
import { generateText, tool } from "ai";
import { z } from "zod";
import { Curb } from "@curb/sdk";

const curb = new Curb({ baseUrl: "http://localhost:8090", apiKey: process.env.CURB_API_KEY });

await curb.run(async () => {
  // 1) Arahkan base URL ke gateway → cost cap & loop detect otomatis, tanpa ubah logika.
  const model = createOpenAI({
    baseURL: "http://localhost:8080/v1",
    headers: curb.gatewayHeaders(), // menempelkan X-Curb-Run-Id
  })("gpt-4o");

  // 2) Bungkus tool berbahaya → ASK/DENY sebelum dieksekusi.
  const hapus = curb.wrapTool(async ({ path }: { path: string }) => `terhapus ${path}`, {
    name: "delete_file",
    sensitivity: "high",
  });

  const { text } = await generateText({
    model,
    prompt: "Bersihkan file sementara di /tmp lalu laporkan.",
    tools: {
      delete_file: tool({
        description: "Hapus sebuah file",
        parameters: z.object({ path: z.string() }),
        execute: hapus, // ← eksekusi ditahan sampai disetujui manusia
      }),
    },
    maxSteps: 5,
  });

  console.log(text);
});
