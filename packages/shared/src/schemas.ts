import { z } from "zod";

export const PolicyScopeSchema = z.object({
  org: z.string().optional(),
  project: z.string().optional(),
  run: z.string().optional(),
  tool: z.string().optional(),
});

export const PolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum([
    "cost_cap",
    "loop_detect",
    "rate_limit",
    "step_limit",
    "time_limit",
    "tool_permission",
  ]),
  scope: PolicyScopeSchema,
  when: z.record(z.unknown()).optional(),
  params: z.record(z.unknown()),
  action: z.enum(["allow", "deny", "ask", "throttle"]),
  enabled: z.boolean(),
});

export const DecisionSchema = z.object({
  effect: z.enum(["ALLOW", "DENY", "ASK", "THROTTLE"]),
  policyId: z.string().optional(),
  reason: z.string().optional(),
  retryAfterMs: z.number().optional(),
});

export type PolicyInput = z.infer<typeof PolicySchema>;
