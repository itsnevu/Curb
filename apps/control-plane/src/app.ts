import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import type { RunStateStore } from "@curb/shared";
import { ApprovalHub } from "./approval-hub.js";
import { makeAuth } from "./auth.js";
import { NULL_NOTIFIER, type Notifier } from "./notify.js";
import type { Repo } from "./repo/types.js";
import { registerApprovals } from "./routes/approvals.js";
import { registerDecisions } from "./routes/decisions.js";
import { registerObservability } from "./routes/observability.js";
import { registerPolicies } from "./routes/policies.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface ControlPlaneDeps {
  repo: Repo;
  store: RunStateStore;
  now?: () => number;
  failMode?: "open" | "closed";
  logger?: boolean;
  /** Dashboard butuh key untuk memanggil API-nya sendiri dari browser. */
  dashboardApiKey?: string;
  notifier?: Notifier;
}

export function buildApp(deps: ControlPlaneDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });
  const now = deps.now ?? Date.now;
  const hub = new ApprovalHub(deps.repo);

  app.get("/health", async () => ({ ok: true, service: "curb-control-plane" }));

  // Dashboard: satu file HTML tanpa build step, dilayani langsung oleh Fastify.
  app.get("/", async (_req, reply) => {
    const html = readFileSync(join(HERE, "public", "dashboard.html"), "utf8").replace(
      "__CURB_API_KEY__",
      deps.dashboardApiKey ?? "",
    );
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.register(async (api) => {
    api.addHook("preHandler", makeAuth(deps.repo));
    registerDecisions(api, {
      repo: deps.repo,
      store: deps.store,
      now,
      failMode: deps.failMode ?? "closed",
      notifier: deps.notifier ?? NULL_NOTIFIER,
    });
    registerPolicies(api, deps.repo);
    registerApprovals(api, deps.repo, hub, now);
    registerObservability(api, deps.repo, deps.notifier ?? NULL_NOTIFIER);
  });

  app.decorate("approvalHub", hub);
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    approvalHub: ApprovalHub;
  }
}
