import { describe, it, expect } from "vitest";
import { formatStaticFindings } from "../src/analysis/formatter.js";
import { getChecker } from "../src/analysis/registry.js";
import "../src/analysis/checkers/index.js";

describe("formatStaticFindings", () => {
  it("includes experimental checker findings when checker order includes them", () => {
    const packageApi = getChecker("packageApi");
    expect(packageApi).toBeDefined();

    const results = new Map([
      ["packageApi", {
        checkerId: "packageApi",
        checked: 1,
        hallucinated: 1,
        hallucinations: [{
          raw: "import { NextRequest } from 'next'",
          category: "hallucinated-named-import",
        }],
        catchItems: ["import { NextRequest } from 'next'"],
        applicable: true,
        rawAnalysis: {
          totalBindings: 1,
          checkedBindings: 1,
          checkedMembers: 0,
          hallucinations: [{
            raw: "import { NextRequest } from 'next'",
            category: "hallucinated-named-import",
          }],
          applicable: true,
        },
      }],
    ]);

    const defaultOutput = formatStaticFindings(results);
    expect(defaultOutput).toBeUndefined();

    const includeOutput = formatStaticFindings(results, {
      checkers: [packageApi!],
    });
    expect(includeOutput).toContain("Package API Issues");
    expect(includeOutput).toContain("NextRequest");
  });
});
