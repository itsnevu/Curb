import { Redis } from "ioredis";
import { InMemoryRunStateStore, RedisRunStateStore, type RedisLike } from "@curb/policy-engine";
import type { RunStateStore } from "@curb/shared";
import { buildApp } from "./app.js";
import { HttpAuditSink, NULL_SINK, type AuditSink } from "./audit.js";
import { ALLOW_ANONYMOUS, keyAuthenticator, type Authenticator } from "./auth.js";
import { forwardUpstream } from "./intercept.js";
import { PolicySource } from "./policy-source.js";
import { PriceTable } from "./pricing.js";

const controlPlaneUrl = process.env.CONTROL_PLANE_URL;
const apiKey = process.env.CURB_API_KEY;
const projectId = process.env.CURB_PROJECT_ID ?? "default";
const allowAnonymous = process.env.CURB_ALLOW_ANONYMOUS === "1";

/**
 * An unauthenticated gateway is an open proxy AND a policy bypass: the project a
 * request belongs to would come from a header the caller writes. Refuse to start
 * rather than come up quietly insecure.
 */
if (!apiKey && !allowAnonymous) {
  console.error(
    "curb gateway: CURB_API_KEY is not set.\n" +
      "  Set it (the same key your agents send as x-curb-key), or set CURB_ALLOW_ANONYMOUS=1\n" +
      "  to run without authentication — local development only.",
  );
  process.exit(1);
}

const authenticate: Authenticator = apiKey
  ? keyAuthenticator([{ key: apiKey, projectId }])
  : ALLOW_ANONYMOUS;

const store: RunStateStore = process.env.REDIS_URL
  ? new RedisRunStateStore(new Redis(process.env.REDIS_URL) as unknown as RedisLike)
  : new InMemoryRunStateStore(() => Date.now());

const audit: AuditSink = controlPlaneUrl
  ? new HttpAuditSink(controlPlaneUrl, { apiKey, onError: (e) => app.log.warn({ e }, "audit delivery failed") })
  : NULL_SINK;

const policySource = new PolicySource({ controlPlaneUrl, apiKey });

const app = buildApp({
  store,
  loadPolicies: () => policySource.load(),
  forward: forwardUpstream,
  audit,
  prices: new PriceTable(),
  failMode: process.env.CURB_FAIL_MODE === "open" ? "open" : "closed",
  authenticate,
  bodyLimit: Number(process.env.CURB_BODY_LIMIT_BYTES ?? 32 * 1024 * 1024),
  logger: true,
});

const port = Number(process.env.GATEWAY_PORT ?? 8080);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => {
    if (!apiKey) app.log.warn("gateway is running WITHOUT authentication (CURB_ALLOW_ANONYMOUS=1)");
    app.log.info(
      { port, store: process.env.REDIS_URL ? "redis" : "memory", controlPlaneUrl, projectId },
      "curb gateway ready",
    );
  })
  .catch((err) => {
    app.log.error({ err }, "gateway failed to start");
    process.exit(1);
  });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
