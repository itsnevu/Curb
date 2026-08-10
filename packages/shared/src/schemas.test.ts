import { describe, it, expect } from "vitest";
import { PolicySchema, DecisionSchema } from "./schemas.js";

const valid = {
  id: "p1", name: "cap", type: "cost_cap", scope: {}, params: { maxUsd: 2 }, action: "deny", enabled: true,
};

describe("PolicySchema", () => {
  it("menerima policy yang benar", () => {
    expect(PolicySchema.safeParse(valid).success).toBe(true);
  });
  it("menolak type di luar daftar", () => {
    expect(PolicySchema.safeParse({ ...valid, type: "ngaco" }).success).toBe(false);
  });
  it("menolak action di luar daftar", () => {
    expect(PolicySchema.safeParse({ ...valid, action: "mungkin" }).success).toBe(false);
  });
  it("menolak field wajib yang hilang", () => {
    const { enabled, ...tanpaEnabled } = valid;
    expect(PolicySchema.safeParse(tanpaEnabled).success).toBe(false);
  });
  it("scope & when opsional", () => {
    expect(PolicySchema.safeParse({ ...valid, when: { env: "prod" } }).success).toBe(true);
  });
});

describe("DecisionSchema", () => {
  it("menerima keempat effect", () => {
    for (const effect of ["ALLOW", "DENY", "ASK", "THROTTLE"]) {
      expect(DecisionSchema.safeParse({ effect }).success).toBe(true);
    }
  });
  it("menolak effect huruf kecil", () => {
    expect(DecisionSchema.safeParse({ effect: "deny" }).success).toBe(false);
  });
});
