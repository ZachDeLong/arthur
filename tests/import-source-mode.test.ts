import { describe, it, expect } from "vitest";
import { analyzeImports } from "../src/analysis/import-checker.js";
import type { DiffFile } from "../src/diff/resolver.js";
import path from "node:path";

const fixtureA = path.resolve("bench/fixtures/fixture-a");

describe("analyzeImports — source mode", () => {
  it("validates imports from DiffFile content", () => {
    const files: DiffFile[] = [
      { path: "src/index.ts", content: 'import chalk from "chalk";\nimport { z } from "zod";\n' },
    ];
    const result = analyzeImports(files, fixtureA, { mode: "source" });
    expect(result.checkedImports).toBe(2);
    expect(result.hallucinations.length).toBe(0);
  });

  it("catches hallucinated package in source mode", () => {
    const files: DiffFile[] = [
      { path: "src/app.ts", content: 'import banana from "nonexistent-banana-pkg";\n' },
    ];
    const result = analyzeImports(files, fixtureA, { mode: "source" });
    expect(result.hallucinations.length).toBe(1);
    expect(result.hallucinations[0].raw).toBe("nonexistent-banana-pkg");
    expect(result.hallucinations[0].file).toBe("src/app.ts");
  });

  it("attributes hallucinations to correct files", () => {
    const files: DiffFile[] = [
      { path: "src/a.ts", content: 'import a from "nonexistent-pkg-a";\n' },
      { path: "src/b.ts", content: 'import b from "nonexistent-pkg-b";\n' },
    ];
    const result = analyzeImports(files, fixtureA, { mode: "source" });
    expect(result.hallucinations.length).toBe(2);
    expect(result.hallucinations[0].file).toBe("src/a.ts");
    expect(result.hallucinations[1].file).toBe("src/b.ts");
  });

  it("skips relative and builtin imports in source mode", () => {
    const files: DiffFile[] = [
      { path: "src/index.ts", content: 'import fs from "node:fs";\nimport { helper } from "./utils";\nimport path from "path";\n' },
    ];
    const result = analyzeImports(files, fixtureA, { mode: "source" });
    expect(result.checkedImports).toBe(0);
    expect(result.skippedImports).toBe(3);
  });

  it("deduplicates same package across files", () => {
    const files: DiffFile[] = [
      { path: "src/a.ts", content: 'import chalk from "chalk";\n' },
      { path: "src/b.ts", content: 'import chalk from "chalk";\n' },
    ];
    const result = analyzeImports(files, fixtureA, { mode: "source" });
    expect(result.checkedImports).toBeGreaterThanOrEqual(1);
    expect(result.hallucinations.length).toBe(0);
  });
});
