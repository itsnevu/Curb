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
  notifier?: Notifier;
}

export function buildApp(deps: ControlPlaneDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });
  const now = deps.now ?? Date.now;
  const hub = new ApprovalHub(deps.repo);

  app.get("/health", async () => ({ ok: true, service: "curb-control-plane" }));

  // Dashboard: a single HTML file with no build step, served directly by Fastify.
  // why: this page is served WITHOUT auth (you need it to log in), so it must never
  // contain a key. The browser asks for the API key, keeps it in sessionStorage, and
  // sends it per request — the server never embeds a credential in the HTML.
  const dashboard = readFileSync(join(HERE, "public", "dashboard.html"), "utf8");
  app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(dashboard));

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
