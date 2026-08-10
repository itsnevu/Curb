import { z } from "zod";

/**
 * Strict for the same reason params are: a scope key that is silently dropped turns a
 * policy the author narrowed into a global one. `scope: {env: "prod"}` is the common
 * mistake — environment is matched by `when`, not `scope` — and it used to widen a
 * prod-only rule to every run without a word.
 */
export const PolicyScopeSchema = z
  .object({
    org: z.string().optional(),
    project: z.string().optional(),
    run: z.string().optional(),
    tool: z.string().optional(),
  })
  .strict();

/**
 * Per-type parameter rules. A policy whose params are wrong is worse than no policy:
 * it looks like protection and silently protects nothing. Unknown extra keys are
 * rejected so a typo like `maxUSD` fails loudly at write time instead of at 3am.
 */
export const POLICY_PARAMS = {
  cost_cap: z
    .object({
      maxUsd: z.number().positive(),
      window: z.enum(["run", "hour", "day"]).default("run"),
      /** Hold a call whose *estimated* cost would break the cap. On by default. */
      preflight: z.boolean().default(true),
    })
    .strict(),
  loop_detect: z
    .object({
      maxRepeats: z.number().int().min(2).default(3),
      signatureWindow: z.number().int().positive().default(10),
    })
    .strict(),
  rate_limit: z
    .object({ maxCalls: z.number().int().nonnegative(), perMs: z.number().int().positive() })
    .strict(),
  step_limit: z.object({ maxSteps: z.number().int().positive() }).strict(),
  time_limit: z.object({ maxWallClockMs: z.number().int().positive() }).strict(),
  tool_permission: z
    .object({
      tools: z.array(z.string()).optional(),
      sensitivity: z.enum(["low", "medium", "high"]).optional(),
      /** Legacy/explicit override of `action` for this policy only. */
      mode: z.enum(["ask", "deny", "allow"]).optional(),
    })
    .strict()
    .refine((p) => (p.tools && p.tools.length > 0) || p.sensitivity, {
      message: "tool_permission needs `tools` or `sensitivity` — otherwise it matches nothing",
    }),
} as const;

export const PolicyTypeSchema = z.enum([
  "cost_cap",
  "loop_detect",
  "rate_limit",
  "step_limit",
  "time_limit",
  "tool_permission",
]);

const PolicyBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: PolicyTypeSchema,
  scope: PolicyScopeSchema,
  when: z.record(z.unknown()).optional(),
  params: z.record(z.unknown()),
  action: z.enum(["allow", "deny", "ask", "throttle"]),
  enabled: z.boolean(),
});

/** Validates the envelope, then the params against the rules for that type. */
export const PolicySchema = PolicyBaseSchema.superRefine((policy, ctx) => {
  const schema = POLICY_PARAMS[policy.type];
  const parsed = schema.safeParse(policy.params);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({ ...issue, path: ["params", ...issue.path] });
  }
}).transform((policy) => ({
  ...policy,
  // Defaults are materialised here so the engine never has to guess.
  params: POLICY_PARAMS[policy.type].parse(policy.params) as Record<string, unknown>,
}));

/** The envelope only — for callers that need `.extend()` / `.shape`. */
export const PolicyShapeSchema = PolicyBaseSchema;

export const DecisionSchema = z.object({
  effect: z.enum(["ALLOW", "DENY", "ASK", "THROTTLE"]),
  policyId: z.string().optional(),
  reason: z.string().optional(),
  retryAfterMs: z.number().optional(),
});

export type PolicyInput = z.infer<typeof PolicySchema>;
