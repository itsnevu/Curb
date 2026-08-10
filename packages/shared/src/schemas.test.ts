import { describe, it, expect } from "vitest";
import { PolicySchema, DecisionSchema } from "./schemas.js";

const valid = {
  id: "p1", name: "cap", type: "cost_cap", scope: {}, params: { maxUsd: 2 }, action: "deny", enabled: true,
};

describe("PolicySchema", () => {
  it("accepts a valid policy", () => {
    expect(PolicySchema.safeParse(valid).success).toBe(true);
  });
  it("rejects a type outside the list", () => {
    expect(PolicySchema.safeParse({ ...valid, type: "ngaco" }).success).toBe(false);
  });
  it("rejects an action outside the list", () => {
    expect(PolicySchema.safeParse({ ...valid, action: "mungkin" }).success).toBe(false);
  });
  it("rejects a missing required field", () => {
    const { enabled, ...tanpaEnabled } = valid;
    expect(PolicySchema.safeParse(tanpaEnabled).success).toBe(false);
  });
  it("scope and when are optional", () => {
    expect(PolicySchema.safeParse({ ...valid, when: { env: "prod" } }).success).toBe(true);
  });
});

describe("DecisionSchema", () => {
  it("accepts all four effects", () => {
    for (const effect of ["ALLOW", "DENY", "ASK", "THROTTLE"]) {
      expect(DecisionSchema.safeParse({ effect }).success).toBe(true);
    }
  });
  it("rejects a lowercase effect", () => {
    expect(DecisionSchema.safeParse({ effect: "deny" }).success).toBe(false);
  });
});
