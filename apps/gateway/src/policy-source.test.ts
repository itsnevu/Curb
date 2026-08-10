import { describe, it, expect } from "vitest";
import { parsePolicies } from "./policy-source.js";

const valid = {
  id: "p1", name: "cap", type: "cost_cap", scope: {}, params: { maxUsd: 2 }, action: "deny", enabled: true,
};

describe("parsePolicies", () => {
  it("menerima array polos", () => {
    expect(parsePolicies([valid])).toHaveLength(1);
  });
  it("menerima bentuk { policies: [...] }", () => {
    expect(parsePolicies({ policies: [valid] })).toHaveLength(1);
  });
  it("membuang policy tidak valid, menyimpan sisanya", () => {
    // why: satu policy rusak tidak boleh mematikan seluruh penegakan
    const out = parsePolicies([valid, { id: "x" }, { ...valid, id: "p2", type: "tipe_ngaco" }]);
    expect(out.map((p) => p.id)).toEqual(["p1"]);
  });
  it("body kosong/aneh → tidak melempar", () => {
    expect(parsePolicies(null)).toEqual([]);
    expect(parsePolicies("bukan json")).toEqual([]);
  });
});
