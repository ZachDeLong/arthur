import { describe, it, expect } from "vitest";
import { getCheckers, getChecker, type CheckerInput } from "../src/analysis/registry.js";
import "../src/analysis/checkers/index.js";
import { buildCatchFindings } from "../src/logging/catches.js";

describe("Checker Registry", () => {
  it("has all expected non-experimental checkers registered", () => {
    const checkers = getCheckers();
    const ids = checkers.map(c => c.id);

    expect(ids).toContain("paths");
    expect(ids).toContain("schema");
    expect(ids).toContain("sqlSchema");
    expect(ids).toContain("imports");
    expect(ids).toContain("env");
    expect(ids).toContain("routes");
    expect(ids).toContain("supabaseSchema");
    expect(ids).toContain("expressRoutes");
    // packageApi is experimental — excluded by default
    expect(ids).not.toContain("packageApi");
  });

  it("includes experimental checkers when requested", () => {
    const checkers = getCheckers({ includeExperimental: true });
    const ids = checkers.map(c => c.id);

    expect(ids).toContain("packageApi");
    expect(ids).toContain("paths");
  });

  it("getChecker returns correct checker by ID", () => {
    const paths = getChecker("paths");
    expect(paths).toBeDefined();
    expect(paths!.displayName).toBe("File Paths");

    const express = getChecker("expressRoutes");
    expect(express).toBeDefined();
    expect(express!.displayName).toBe("Express/Fastify Routes");
  });

  it("getChecker returns undefined for unknown ID", () => {
    expect(getChecker("nonexistent")).toBeUndefined();
  });

  it("each checker has required properties", () => {
    for (const checker of getCheckers({ includeExperimental: true })) {
      expect(checker.id).toBeTruthy();
      expect(checker.displayName).toBeTruthy();
      expect(checker.catchKey).toBeTruthy();
      expect(typeof checker.run).toBe("function");
      expect(typeof checker.formatForCheckAll).toBe("function");
      expect(typeof checker.formatForFindings).toBe("function");
    }
  });
});

describe("buildCatchFindings", () => {
  it("builds a record with one key", () => {
    const findings = buildCatchFindings("paths", 10, 2, ["a", "b"]);
    expect(findings).toEqual({
      paths: { checked: 10, hallucinated: 2, items: ["a", "b"] },
    });
  });

  it("works with zero hallucinations", () => {
    const findings = buildCatchFindings("imports", 5, 0, []);
    expect(findings).toEqual({
      imports: { checked: 5, hallucinated: 0, items: [] },
    });
  });
});

describe("CheckerInput source mode", () => {
  it("all checkers handle source mode without crashing", () => {
    const input: CheckerInput = {
      mode: "source",
      text: 'import express from "express";\n',
      files: [{ path: "src/index.ts", content: 'import express from "express";\n' }],
    };

    for (const checker of getCheckers({ includeExperimental: true })) {
      const result = checker.run(input, ".");
      if (!checker.supportsSourceMode) {
        expect(result.applicable).toBe(false);
        expect(result.notApplicableReason).toContain("source mode");
      }
    }
  });
});
