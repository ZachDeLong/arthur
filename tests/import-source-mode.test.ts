import { describe, it, expect } from "vitest";
import { analyzeImports } from "../src/analysis/import-checker.js";
import type { DiffFile } from "../src/diff/resolver.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

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

  it("checks only imports that intersect changed lines", () => {
    const files: DiffFile[] = [{
      path: "src/index.ts",
      content: [
        'import old from "unchanged-hallucinated-package";',
        'import chalk from "chalk";',
        'import fresh from "new-hallucinated-package";',
      ].join("\n"),
      changedLines: [2, 3],
    }];

    const result = analyzeImports(files, fixtureA, { mode: "source" });
    expect(result.checkedImports).toBe(2);
    expect(result.hallucinations).toHaveLength(1);
    expect(result.hallucinations[0].raw).toBe("new-hallucinated-package");
    expect(result.hallucinations[0].location).toMatchObject({
      path: "src/index.ts",
      line: 3,
    });
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

  it("marks declared but unavailable packages as unverified instead of valid", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "arthur-import-ground-truth-"));
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
      dependencies: { "declared-only-package": "^1.0.0" },
    }));

    try {
      const result = analyzeImports([{
        path: "src/index.ts",
        content: 'import value from "declared-only-package";\n',
        changedLines: [1],
      }], projectDir, { mode: "source" });

      expect(result.checkedImports).toBe(0);
      expect(result.validImports).toBe(0);
      expect(result.unverifiedImports).toHaveLength(1);
      expect(result.unverifiedImports[0].reason).toBe("declared-not-installed");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("ignores import-shaped text in comments and strings", () => {
    const result = analyzeImports([{
      path: "src/index.ts",
      content: [
        '// import fake from "comment-only-package";',
        'const example = `require("string-only-package")`;',
      ].join("\n"),
      changedLines: [1, 2],
    }], fixtureA, { mode: "source" });

    expect(result.totalImports).toBe(0);
    expect(result.hallucinations).toEqual([]);
  });

  it("uses a changed package.json as the staged dependency view", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "arthur-import-overlay-"));
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ dependencies: {} }));

    try {
      const result = analyzeImports([
        {
          path: "package.json",
          content: JSON.stringify({ dependencies: { "future-installed-package": "^1.0.0" } }),
          changedLines: [1],
          status: "modified",
        },
        {
          path: "src/index.ts",
          content: 'import value from "future-installed-package";\n',
          changedLines: [1],
          status: "added",
        },
      ], projectDir, { mode: "source" });

      expect(result.hallucinations).toEqual([]);
      expect(result.unverifiedImports).toHaveLength(1);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("resolves installed packages from the importing workspace", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "arthur-import-workspace-"));
    const frontendDir = path.join(projectDir, "frontend");
    const packageDir = path.join(frontendDir, "node_modules", "react");
    fs.mkdirSync(path.join(frontendDir, "src"), { recursive: true });
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(frontendDir, "package.json"), JSON.stringify({
      dependencies: { react: "^19.0.0" },
    }));
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
      name: "react",
      version: "19.0.0",
    }));

    try {
      const result = analyzeImports([{
        path: "frontend/src/App.tsx",
        content: 'import React from "react";\n',
        changedLines: [1],
      }], projectDir, { mode: "source" });

      expect(result.checkedImports).toBe(1);
      expect(result.validImports).toBe(1);
      expect(result.hallucinations).toEqual([]);
      expect(result.unverifiedImports).toEqual([]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("uses a changed nested package.json as the staged workspace view", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "arthur-import-workspace-overlay-"));
    fs.mkdirSync(path.join(projectDir, "frontend", "src"), { recursive: true });

    try {
      const result = analyzeImports([
        {
          path: "frontend/package.json",
          content: JSON.stringify({ dependencies: { "future-workspace-package": "^1.0.0" } }),
          changedLines: [1],
          status: "added",
        },
        {
          path: "frontend/src/App.tsx",
          content: 'import value from "future-workspace-package";\n',
          changedLines: [1],
          status: "added",
        },
      ], projectDir, { mode: "source" });

      expect(result.hallucinations).toEqual([]);
      expect(result.unverifiedImports).toHaveLength(1);
      expect(result.unverifiedImports[0]).toMatchObject({
        raw: "future-workspace-package",
        file: "frontend/src/App.tsx",
        reason: "declared-not-installed",
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("does not share package validation across sibling workspaces", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "arthur-import-workspace-cache-"));
    const installedDir = path.join(projectDir, "apps", "installed", "node_modules", "workspace-only");
    fs.mkdirSync(installedDir, { recursive: true });
    fs.mkdirSync(path.join(projectDir, "apps", "missing", "src"), { recursive: true });
    fs.writeFileSync(path.join(installedDir, "package.json"), JSON.stringify({
      name: "workspace-only",
      version: "1.0.0",
    }));

    try {
      const result = analyzeImports([
        {
          path: "apps/installed/src/index.ts",
          content: 'import value from "workspace-only";\n',
          changedLines: [1],
        },
        {
          path: "apps/missing/src/index.ts",
          content: 'import value from "workspace-only";\n',
          changedLines: [1],
        },
      ], projectDir, { mode: "source" });

      expect(result.checkedImports).toBe(2);
      expect(result.validImports).toBe(1);
      expect(result.hallucinations).toHaveLength(1);
      expect(result.hallucinations[0]).toMatchObject({
        raw: "workspace-only",
        file: "apps/missing/src/index.ts",
        reason: "package-not-found",
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("escapes regex characters in package export patterns", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "arthur-import-pattern-"));
    const packageDir = path.join(projectDir, "node_modules", "pattern-package");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
      name: "pattern-package",
      exports: { "./feature+/*": "./dist/*.js" },
    }));

    try {
      const result = analyzeImports([{
        path: "src/index.ts",
        content: 'import value from "pattern-package/featureee/value";\n',
        changedLines: [1],
      }], projectDir, { mode: "source" });

      expect(result.hallucinations).toHaveLength(1);
      expect(result.hallucinations[0].reason).toBe("subpath-not-exported");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
