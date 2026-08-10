import { describe, it, expect } from "vitest";
import { parsePolicies } from "./policy-source.js";

const valid = {
  id: "p1", name: "cap", type: "cost_cap", scope: {}, params: { maxUsd: 2 }, action: "deny", enabled: true,
};

describe("parsePolicies", () => {
  it("accepts a plain array", () => {
    expect(parsePolicies([valid])).toHaveLength(1);
  });
  it("accepts the { policies: [...] } shape", () => {
    expect(parsePolicies({ policies: [valid] })).toHaveLength(1);
  });
  it("drops invalid policies and keeps the rest", () => {
    // why: one broken policy must not disable enforcement entirely
    const out = parsePolicies([valid, { id: "x" }, { ...valid, id: "p2", type: "bogus_type" }]);
    expect(out.map((p) => p.id)).toEqual(["p1"]);
  });
  it("empty or odd bodies → does not throw", () => {
    expect(parsePolicies(null)).toEqual([]);
    expect(parsePolicies("not-json")).toEqual([]);
  });
});
