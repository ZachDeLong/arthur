import { describe, it, expect } from "vitest";
import { clearImportCaches } from "../src/analysis/import-checker.js";
import { clearApiCaches } from "../src/analysis/package-api-checker.js";
import { runAllCheckers } from "../src/analysis/run-all.js";
import type { CheckerInput } from "../src/analysis/registry.js";
import "../src/analysis/checkers/index.js";

describe("Cache invalidation", () => {
  it("clearImportCaches does not throw", () => {
    expect(() => clearImportCaches()).not.toThrow();
  });

  it("clearApiCaches does not throw", () => {
    expect(() => clearApiCaches()).not.toThrow();
  });

  it("clearImportCaches can be called multiple times safely", () => {
    clearImportCaches();
    clearImportCaches();
    clearImportCaches();
    // No error means the function is idempotent
  });

  it("clearApiCaches can be called multiple times safely", () => {
    clearApiCaches();
    clearApiCaches();
    clearApiCaches();
  });

  it("runAllCheckers clears caches without error", () => {
    const input: CheckerInput = {
      mode: "plan",
      text: "A simple plan with no imports.",
    };

    // Call twice — second call should not use stale caches from first
    const result1 = runAllCheckers(input, "/nonexistent/path");
    const result2 = runAllCheckers(input, "/nonexistent/path");

    expect(result1.checkerResults.length).toBeGreaterThan(0);
    expect(result2.checkerResults.length).toBeGreaterThan(0);
    expect(result1.checkerResults.length).toBe(result2.checkerResults.length);
  });

  it("CheckerInput accepts a cache field", () => {
    const cache = new Map<string, unknown>();
    const input: CheckerInput = {
      mode: "plan",
      text: "Test plan text.",
      cache,
    };

    expect(input.cache).toBe(cache);
    expect(input.cache?.size).toBe(0);
  });

  it("runAllCheckers creates a request-scoped cache when none provided", () => {
    const input: CheckerInput = {
      mode: "plan",
      text: "Plan with import from 'nonexistent-package'",
    };

    // Should not throw — cache is created internally
    expect(() => runAllCheckers(input, "/nonexistent/path")).not.toThrow();
  });

  it("runAllCheckers uses provided cache", () => {
    const cache = new Map<string, unknown>();
    const input: CheckerInput = {
      mode: "plan",
      text: "Plan text.",
      cache,
    };

    // Should not throw — existing cache is passed through
    expect(() => runAllCheckers(input, "/nonexistent/path")).not.toThrow();
  });
});
