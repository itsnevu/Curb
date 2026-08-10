import type { FastifyReply, FastifyRequest } from "fastify";

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  perMinute: number;
  now?: () => number;
}

/**
 * A per-project fixed-window limiter, in process.
 *
 * why bother: /v1/decisions sits in the hot path of every guarded tool call, and a
 * looping agent is exactly the kind of client that hammers it thousands of times a
 * second. This keeps one runaway run from starving every other project. It is not a
 * distributed limiter — with several replicas the effective ceiling is per replica,
 * which is fine for the job it does here.
 */
export function rateLimiter(opts: RateLimitOptions) {
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, Bucket>();

  return async function limit(req: FastifyRequest, reply: FastifyReply) {
    if (opts.perMinute <= 0) return;
    const id = req.project?.id ?? "anonymous";
    const t = now();
    let bucket = buckets.get(id);
    if (!bucket || bucket.resetAt <= t) {
      bucket = { count: 0, resetAt: t + 60_000 };
      buckets.set(id, bucket);
    }
    bucket.count++;
    if (bucket.count > opts.perMinute) {
      const retryAfterMs = bucket.resetAt - t;
      reply.header("retry-after", Math.ceil(retryAfterMs / 1000));
      return reply.code(429).send({
        error: {
          message: `rate limit: more than ${opts.perMinute} requests/minute for this project`,
          type: "curb_rate_limited",
        },
      });
    }
    // Housekeeping: drop expired buckets so an app with many projects cannot grow forever.
    if (buckets.size > 10_000) {
      for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
    }
  };
}
