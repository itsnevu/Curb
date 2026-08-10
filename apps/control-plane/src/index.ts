import { Redis } from "ioredis";
import { InMemoryRunStateStore, RedisRunStateStore, type RedisLike } from "@curb/policy-engine";
import type { RunStateStore } from "@curb/shared";
import { buildApp } from "./app.js";
import { ensureDevProject } from "./auth.js";
import { notifierFromEnv } from "./notify.js";
import { MemoryRepo } from "./repo/memory.js";
import { PostgresRepo } from "./repo/postgres.js";
import type { Repo } from "./repo/types.js";

const repo: Repo = process.env.DATABASE_URL
  ? new PostgresRepo(process.env.DATABASE_URL)
  : new MemoryRepo();

const store: RunStateStore = process.env.REDIS_URL
  ? new RedisRunStateStore(new Redis(process.env.REDIS_URL) as unknown as RedisLike)
  : new InMemoryRunStateStore(() => Date.now());

const app = buildApp({
  repo,
  store,
  failMode: process.env.CURB_FAIL_MODE === "open" ? "open" : "closed",
  logger: true,
  dashboardApiKey: process.env.CURB_API_KEY,
  notifier: notifierFromEnv({ onError: (err) => app.log.warn({ err }, "alert delivery failed") }),
});

const port = Number(process.env.CONTROL_PLANE_PORT ?? 8090);

async function main() {
  await repo.init();
  await ensureDevProject(repo, process.env.CURB_API_KEY);
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(
    { port, db: process.env.DATABASE_URL ? "postgres" : "memory", state: process.env.REDIS_URL ? "redis" : "memory" },
    "curb control-plane ready",
  );
}

main().catch((err) => {
  app.log.error({ err }, "control-plane failed to start");
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => repo.close()).then(() => process.exit(0));
  });
}
