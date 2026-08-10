import { z } from "zod";
export declare const PolicyScopeSchema: z.ZodObject<{
    org: z.ZodOptional<z.ZodString>;
    project: z.ZodOptional<z.ZodString>;
    run: z.ZodOptional<z.ZodString>;
    tool: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    org?: string | undefined;
    project?: string | undefined;
    run?: string | undefined;
    tool?: string | undefined;
}, {
    org?: string | undefined;
    project?: string | undefined;
    run?: string | undefined;
    tool?: string | undefined;
}>;
export declare const PolicySchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    type: z.ZodEnum<["cost_cap", "loop_detect", "rate_limit", "step_limit", "time_limit", "tool_permission"]>;
    scope: z.ZodObject<{
        org: z.ZodOptional<z.ZodString>;
        project: z.ZodOptional<z.ZodString>;
        run: z.ZodOptional<z.ZodString>;
        tool: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        org?: string | undefined;
        project?: string | undefined;
        run?: string | undefined;
        tool?: string | undefined;
    }, {
        org?: string | undefined;
        project?: string | undefined;
        run?: string | undefined;
        tool?: string | undefined;
    }>;
    when: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    params: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    action: z.ZodEnum<["allow", "deny", "ask", "throttle"]>;
    enabled: z.ZodBoolean;
}, "strip", z.ZodTypeAny, {
    params: Record<string, unknown>;
    type: "cost_cap" | "loop_detect" | "rate_limit" | "step_limit" | "time_limit" | "tool_permission";
    id: string;
    name: string;
    scope: {
        org?: string | undefined;
        project?: string | undefined;
        run?: string | undefined;
        tool?: string | undefined;
    };
    action: "allow" | "deny" | "ask" | "throttle";
    enabled: boolean;
    when?: Record<string, unknown> | undefined;
}, {
    params: Record<string, unknown>;
    type: "cost_cap" | "loop_detect" | "rate_limit" | "step_limit" | "time_limit" | "tool_permission";
    id: string;
    name: string;
    scope: {
        org?: string | undefined;
        project?: string | undefined;
        run?: string | undefined;
        tool?: string | undefined;
    };
    action: "allow" | "deny" | "ask" | "throttle";
    enabled: boolean;
    when?: Record<string, unknown> | undefined;
}>;
export declare const DecisionSchema: z.ZodObject<{
    effect: z.ZodEnum<["ALLOW", "DENY", "ASK", "THROTTLE"]>;
    policyId: z.ZodOptional<z.ZodString>;
    reason: z.ZodOptional<z.ZodString>;
    retryAfterMs: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    effect: "ALLOW" | "DENY" | "ASK" | "THROTTLE";
    policyId?: string | undefined;
    reason?: string | undefined;
    retryAfterMs?: number | undefined;
}, {
    effect: "ALLOW" | "DENY" | "ASK" | "THROTTLE";
    policyId?: string | undefined;
    reason?: string | undefined;
    retryAfterMs?: number | undefined;
}>;
export type PolicyInput = z.infer<typeof PolicySchema>;
