import { Redis } from "ioredis";
import { InMemoryRunStateStore, RedisRunStateStore, type RedisLike } from "@curb/policy-engine";
import type { RunStateStore } from "@curb/shared";
import { buildApp } from "./app.js";
import { HttpAuditSink, NULL_SINK, type AuditSink } from "./audit.js";
import { forwardUpstream } from "./intercept.js";
import { PolicySource } from "./policy-source.js";
import { PriceTable } from "./pricing.js";

const controlPlaneUrl = process.env.CONTROL_PLANE_URL;
const apiKey = process.env.CURB_API_KEY;

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
  logger: true,
});

const port = Number(process.env.GATEWAY_PORT ?? 8080);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => {
    app.log.info(
      { port, store: process.env.REDIS_URL ? "redis" : "memory", controlPlaneUrl },
      "curb gateway ready",
    );
  })
  .catch((err) => {
    app.log.error({ err }, "gateway failed to start");
    process.exit(1);
  });
