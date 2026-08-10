import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// why: paket workspace mengekspor ./dist untuk produksi; test dijalankan
// langsung atas sumber supaya tidak perlu build dulu.
const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@curb/shared": src("../../packages/shared/src/index.ts"),
      "@curb/policy-engine": src("../../packages/policy-engine/src/index.ts"),
      "@curb/sdk": src("../../packages/sdk-ts/src/index.ts"),
    },
  },
});
