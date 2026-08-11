import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import type { RunStateStore } from "@curb/shared";
import { ApprovalHub } from "./approval-hub.js";
import { makeAuth } from "./auth.js";
import { throttledExpiry } from "./expiry.js";
import { NULL_NOTIFIER, type Notifier } from "./notify.js";
import { rateLimiter } from "./rate-limit.js";
import type { Repo } from "./repo/types.js";
import { registerApprovals } from "./routes/approvals.js";
import { registerDecisions } from "./routes/decisions.js";
import { registerObservability } from "./routes/observability.js";
import { registerOrg } from "./routes/org.js";
import { registerPolicies } from "./routes/policies.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface ControlPlaneDeps {
  repo: Repo;
  store: RunStateStore;
  now?: () => number;
  failMode?: "open" | "closed";
  logger?: boolean;
  notifier?: Notifier;
  /** Max request body. Tool arguments can be sizeable; audit batches more so. */
  bodyLimit?: number;
  /** Requests per minute per API key. 0 disables the limiter. */
  rateLimitPerMinute?: number;
  /** How long an undecided approval stays actionable. Defaults to 1 hour. */
  approvalTtlMs?: number;
  /** How often the expiry sweep may run. Defaults to 30s; 0 means every request. */
  expirySweepMs?: number;
}

export function buildApp(deps: ControlPlaneDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: deps.bodyLimit ?? 8 * 1024 * 1024,
  });
  const now = deps.now ?? Date.now;
  const hub = new ApprovalHub(deps.repo);
  const approvalTtlMs = deps.approvalTtlMs ?? 60 * 60_000;

  app.get("/health", async () => ({ ok: true, service: "curb-control-plane" }));

  /**
   * Dashboard: one HTML file, no build step, and deliberately NO credentials baked in.
   * This page is served WITHOUT auth (you need it in order to sign in), so it must never
   * contain a key: the browser asks for one and keeps it in sessionStorage. The headers
   * below stop it being cached or framed by anything else.
   */
  const dashboard = readFileSync(join(HERE, "public", "dashboard.html"), "utf8");
  app.get("/", async (_req, reply) => {
    return reply
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header(
        "content-security-policy",
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'",
      )
      .header("referrer-policy", "no-referrer")
      .send(dashboard);
  });

  app.register(async (api) => {
    const limit = rateLimiter({ perMinute: deps.rateLimitPerMinute ?? 600, now });
    api.addHook("preHandler", makeAuth(deps.repo));
    api.addHook("preHandler", limit);
    // Approvals that nobody decided in time must not sit in the queue looking live.
    // Throttled: this is a background chore, not part of serving a request.
    const sweep = throttledExpiry(deps.repo, approvalTtlMs, hub, deps.expirySweepMs ?? 30_000);
    api.addHook("preHandler", async () => {
      await sweep(now());
    });

    registerDecisions(api, {
      repo: deps.repo,
      store: deps.store,
      now,
      failMode: deps.failMode ?? "closed",
      notifier: deps.notifier ?? NULL_NOTIFIER,
      approvalTtlMs,
    });
    registerPolicies(api, deps.repo);
    registerApprovals(api, deps.repo, hub, now);
    registerObservability(api, deps.repo, deps.notifier ?? NULL_NOTIFIER);
    registerOrg(api, deps.repo, now);
  });

  app.decorate("approvalHub", hub);
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    approvalHub: ApprovalHub;
  }
}
