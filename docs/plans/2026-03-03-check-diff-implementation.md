# check --diff Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `arthur check --diff` to validate actual code changes (git diff) against project ground truth, starting with the import checker.

**Architecture:** Extend the checker registry with a `CheckerInput` abstraction that supports both `plan` and `source` modes. A new `src/diff/resolver.ts` module handles git plumbing. The import checker is the first checker to support source mode. CLI and MCP server get new `--diff` / `check_diff` entry points.

**Tech Stack:** TypeScript, Node.js child_process (for git), vitest

---

### Task 1: DiffFile type and git diff resolver

**Files:**
- Create: `src/diff/resolver.ts`

**Step 1: Write the failing test**

Create `tests/diff-resolver.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
import { resolveDiffFiles, type DiffFile } from "../src/diff/resolver.js";

// Helper: create a temp git repo with some files
function createTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arthur-diff-test-"));
  execSync("git init", { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });

  // Create initial commit with a file
  fs.writeFileSync(path.join(dir, "existing.ts"), 'export const x = 1;\n');
  execSync("git add -A", { cwd: dir });
  execSync('git commit -m "init"', { cwd: dir });

  return dir;
}

describe("resolveDiffFiles", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTempGitRepo();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("detects new unstaged .ts files vs HEAD", () => {
    fs.writeFileSync(path.join(repoDir, "newfile.ts"), 'import express from "express";\n');
    execSync("git add newfile.ts", { cwd: repoDir });

    const files = resolveDiffFiles(repoDir, "HEAD");
    expect(files.length).toBe(1);
    expect(files[0].path).toBe("newfile.ts");
    expect(files[0].content).toContain("express");
  });

  it("detects staged files with --staged", () => {
    fs.writeFileSync(path.join(repoDir, "staged.ts"), 'import zod from "zod";\n');
    execSync("git add staged.ts", { cwd: repoDir });

    const files = resolveDiffFiles(repoDir, "HEAD", { staged: true });
    expect(files.length).toBe(1);
    expect(files[0].path).toBe("staged.ts");
  });

  it("filters to supported extensions only", () => {
    fs.writeFileSync(path.join(repoDir, "readme.md"), "# Hello\n");
    fs.writeFileSync(path.join(repoDir, "data.json"), "{}");
    fs.writeFileSync(path.join(repoDir, "code.ts"), 'const x = 1;\n');
    execSync("git add -A", { cwd: repoDir });

    const files = resolveDiffFiles(repoDir, "HEAD");
    expect(files.length).toBe(1);
    expect(files[0].path).toBe("code.ts");
  });

  it("handles modified files", () => {
    // Modify the existing committed file
    fs.writeFileSync(path.join(repoDir, "existing.ts"), 'import foo from "foo";\nexport const x = 2;\n');
    execSync("git add existing.ts", { cwd: repoDir });

    const files = resolveDiffFiles(repoDir, "HEAD");
    expect(files.length).toBe(1);
    expect(files[0].path).toBe("existing.ts");
    expect(files[0].content).toContain("foo");
  });

  it("returns empty array when no changes", () => {
    const files = resolveDiffFiles(repoDir, "HEAD");
    expect(files).toEqual([]);
  });

  it("throws on non-git directory", () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "arthur-nogit-"));
    try {
      expect(() => resolveDiffFiles(nonGitDir, "HEAD")).toThrow();
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("supports diff against a branch ref", () => {
    // Create a branch, add a file, diff against main
    execSync("git checkout -b feature", { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "feature.tsx"), 'import React from "react";\n');
    execSync("git add feature.tsx", { cwd: repoDir });
    execSync('git commit -m "feature"', { cwd: repoDir });

    const files = resolveDiffFiles(repoDir, "master");
    expect(files.length).toBe(1);
    expect(files[0].path).toBe("feature.tsx");
  });

  it("skips deleted files", () => {
    // Delete the existing file
    fs.unlinkSync(path.join(repoDir, "existing.ts"));
    execSync("git add -A", { cwd: repoDir });

    const files = resolveDiffFiles(repoDir, "HEAD");
    // Deleted files should not be returned (--diff-filter=ACMR excludes D)
    expect(files).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd C:/Users/zachd/arthur && npx vitest run tests/diff-resolver.test.ts`
Expected: FAIL — module `../src/diff/resolver.js` does not exist

**Step 3: Write minimal implementation**

Create `src/diff/resolver.ts`:

```typescript
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface DiffFile {
  /** Relative path from project root (e.g., "src/index.ts") */
  path: string;
  /** Full file content read from disk */
  content: string;
}

interface DiffOptions {
  /** Use --staged instead of working tree diff */
  staged?: boolean;
}

const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
]);

/**
 * Resolve changed files from a git diff.
 *
 * @param projectDir — absolute path to project root (must be a git repo)
 * @param diffRef — git ref to diff against: "HEAD", "origin/main", "HEAD~3", etc.
 * @param options — { staged: true } for staged-only files
 * @returns DiffFile[] — changed files with their current content
 * @throws if projectDir is not a git repo or ref is invalid
 */
export function resolveDiffFiles(
  projectDir: string,
  diffRef: string,
  options: DiffOptions = {},
): DiffFile[] {
  const args = ["diff", "--name-only", "--diff-filter=ACMR"];

  if (options.staged) {
    args.push("--cached");
  }

  args.push(diffRef);

  const output = execSync(`git ${args.join(" ")}`, {
    cwd: projectDir,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();

  if (!output) return [];

  const allPaths = output.split("\n").filter(Boolean);

  const files: DiffFile[] = [];
  for (const relPath of allPaths) {
    const ext = path.extname(relPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

    const fullPath = path.join(projectDir, relPath);
    if (!fs.existsSync(fullPath)) continue; // safety: file might have been deleted

    const content = fs.readFileSync(fullPath, "utf-8");
    files.push({ path: relPath, content });
  }

  return files;
}
```

**Step 4: Run test to verify it passes**

Run: `cd C:/Users/zachd/arthur && npx vitest run tests/diff-resolver.test.ts`
Expected: PASS (all 8 tests)

**Step 5: Commit**

```bash
git add src/diff/resolver.ts tests/diff-resolver.test.ts
git commit -m "Add git diff resolver for check --diff mode"
```

---

### Task 2: CheckerInput abstraction in registry

**Files:**
- Modify: `src/analysis/registry.ts`
- Modify: `src/analysis/run-all.ts`

**Step 1: Write the failing test**

Add to `tests/registry.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { getCheckers, type CheckerInput } from "../src/analysis/registry.js";
import "../src/analysis/checkers/index.js";

describe("CheckerInput source mode", () => {
  it("all checkers handle source mode without crashing", () => {
    const input: CheckerInput = {
      mode: "source",
      text: 'import express from "express";\n',
      files: [{ path: "src/index.ts", content: 'import express from "express";\n' }],
    };

    for (const checker of getCheckers({ includeExperimental: true })) {
      const result = checker.run(input, ".");
      // Checkers that don't support source mode should return not applicable
      if (!checker.supportsSourceMode) {
        expect(result.applicable).toBe(false);
        expect(result.notApplicableReason).toContain("source mode");
      }
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd C:/Users/zachd/arthur && npx vitest run tests/registry.test.ts`
Expected: FAIL — `CheckerInput` type doesn't exist, `run()` signature mismatch

**Step 3: Update registry.ts**

Modify `src/analysis/registry.ts`:

- Add `DiffFile` import from `../diff/resolver.js`
- Add `CheckerInput` interface:
  ```typescript
  export interface CheckerInput {
    mode: "plan" | "source";
    text: string;
    files?: DiffFile[];
  }
  ```
- Add `supportsSourceMode?: boolean` to `CheckerDefinition`
- Change `run` signature from `(planText: string, projectDir: string, options?)` to `(input: CheckerInput, projectDir: string, options?)`
- Export `CheckerInput`

**Step 4: Update all checker registrations**

Update every file in `src/analysis/checkers/` to use the new `run` signature. For all checkers **except** imports (handled in Task 3), wrap the existing logic:

```typescript
// Pattern for all non-source-mode checkers (paths.ts, schema.ts, etc.):
run(input: CheckerInput, projectDir, options): CheckerResult {
  if (input.mode === "source") {
    return {
      checkerId: "<id>",
      checked: 0,
      hallucinated: 0,
      hallucinations: [],
      catchItems: [],
      applicable: false,
      notApplicableReason: "source mode not implemented for this checker",
      rawAnalysis: null,
    };
  }
  // existing logic using input.text instead of planText
  const analysis = analyzeXxx(input.text, projectDir);
  // ... rest unchanged
}
```

Files to update (each one: change `planText` parameter to `input: CheckerInput`, add source mode guard, use `input.text` where `planText` was used):
- `src/analysis/checkers/paths.ts`
- `src/analysis/checkers/schema.ts`
- `src/analysis/checkers/sql-schema.ts`
- `src/analysis/checkers/env.ts`
- `src/analysis/checkers/types.ts`
- `src/analysis/checkers/routes.ts`
- `src/analysis/checkers/supabase-schema.ts`
- `src/analysis/checkers/express-routes.ts`
- `src/analysis/checkers/package-api.ts`

**Step 5: Update run-all.ts**

Modify `src/analysis/run-all.ts`:
- Import `CheckerInput` and `DiffFile` types
- Change `runAllCheckers` signature: replace `planText: string` with `input: CheckerInput`
- Pass `input` through to each `checker.run(input, projectDir, ...)`

```typescript
export function runAllCheckers(
  input: CheckerInput,
  projectDir: string,
  options: RunAllOptions = {},
): CheckerRunSummary {
  // ...
  for (const checker of getCheckers(...)) {
    const result = checker.run(input, projectDir, options.checkerOptions);
    // ... rest unchanged
  }
}
```

**Step 6: Update callers of runAllCheckers**

Update all call sites to pass `CheckerInput` instead of raw `planText`:
- `src/commands/check.ts:178` — wrap: `{ mode: "plan", text: planText }`
- `bin/arthur-mcp.ts:943` (check_all tool) — wrap: `{ mode: "plan", text: planText }`
- `bin/arthur-mcp.ts` (verify_plan tool, wherever it calls runAllCheckers) — wrap: `{ mode: "plan", text: planText }`

Also update any MCP tools that call individual checker `run()` directly — search for `.run(planText` in `arthur-mcp.ts` and update those calls too. Each individual tool (check_paths, check_imports, etc.) calls the analysis functions directly (e.g., `analyzePaths(planText, ...)`), NOT through the registry, so those don't need changes.

**Step 7: Run all tests to verify nothing broke**

Run: `cd C:/Users/zachd/arthur && npx vitest run`
Expected: ALL PASS — existing behavior unchanged, new source mode test passes

**Step 8: Commit**

```bash
git add src/analysis/registry.ts src/analysis/run-all.ts src/analysis/checkers/ src/commands/check.ts bin/arthur-mcp.ts tests/registry.test.ts
git commit -m "Add CheckerInput abstraction with plan/source modes to registry"
```

---

### Task 3: Import checker source mode

**Files:**
- Modify: `src/analysis/import-checker.ts`
- Modify: `src/analysis/checkers/imports.ts`

**Step 1: Write the failing test**

Create `tests/import-source-mode.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { analyzeImports, type ImportAnalysis } from "../src/analysis/import-checker.js";
import type { DiffFile } from "../src/diff/resolver.js";
import path from "node:path";

const fixtureA = path.resolve("bench/fixtures/fixture-a");

describe("analyzeImports — source mode", () => {
  it("validates imports from DiffFile content", () => {
    const files: DiffFile[] = [
      {
        path: "src/index.ts",
        content: 'import chalk from "chalk";\nimport { z } from "zod";\n',
      },
    ];
    // fixture-a has chalk and zod in package.json
    const result = analyzeImports(files, fixtureA, { mode: "source" });
    expect(result.checkedImports).toBe(2);
    expect(result.hallucinations.length).toBe(0);
  });

  it("catches hallucinated package in source mode", () => {
    const files: DiffFile[] = [
      {
        path: "src/app.ts",
        content: 'import banana from "nonexistent-banana-pkg";\n',
      },
    ];
    const result = analyzeImports(files, fixtureA, { mode: "source" });
    expect(result.hallucinations.length).toBe(1);
    expect(result.hallucinations[0].raw).toBe("nonexistent-banana-pkg");
    expect(result.hallucinations[0].file).toBe("src/app.ts");
  });

  it("attributes hallucinations to correct files", () => {
    const files: DiffFile[] = [
      {
        path: "src/a.ts",
        content: 'import a from "nonexistent-pkg-a";\n',
      },
      {
        path: "src/b.ts",
        content: 'import b from "nonexistent-pkg-b";\n',
      },
    ];
    const result = analyzeImports(files, fixtureA, { mode: "source" });
    expect(result.hallucinations.length).toBe(2);
    expect(result.hallucinations[0].file).toBe("src/a.ts");
    expect(result.hallucinations[1].file).toBe("src/b.ts");
  });

  it("skips relative and builtin imports in source mode", () => {
    const files: DiffFile[] = [
      {
        path: "src/index.ts",
        content: 'import fs from "node:fs";\nimport { helper } from "./utils";\nimport path from "path";\n',
      },
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
    // Same valid package in two files — checked once, not duplicated
    expect(result.checkedImports).toBeGreaterThanOrEqual(1);
    expect(result.hallucinations.length).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd C:/Users/zachd/arthur && npx vitest run tests/import-source-mode.test.ts`
Expected: FAIL — `analyzeImports` doesn't accept DiffFile[] or mode option

**Step 3: Update import-checker.ts**

Modify `src/analysis/import-checker.ts`:

1. Add `DiffFile` import:
   ```typescript
   import type { DiffFile } from "../diff/resolver.js";
   ```

2. Add `file?: string` to `ImportRef`:
   ```typescript
   export interface ImportRef {
     raw: string;
     packageName: string;
     subpath?: string;
     valid: boolean;
     reason?: string;
     suggestion?: string;
     file?: string;  // Source file path (source mode only)
   }
   ```

3. Add options type:
   ```typescript
   interface AnalyzeOptions {
     mode?: "plan" | "source";
   }
   ```

4. Update `analyzeImports` signature to support both plan text and source file inputs:
   ```typescript
   export function analyzeImports(
     input: string | DiffFile[],
     projectDir: string,
     options: AnalyzeOptions = {},
   ): ImportAnalysis {
     const mode = options.mode ?? "plan";

     if (mode === "source" && Array.isArray(input)) {
       return analyzeImportsFromFiles(input, projectDir);
     }

     // Existing plan-mode logic (input is string)
     const planText = typeof input === "string" ? input : "";
     // ... rest of existing logic unchanged
   }
   ```

5. Add the source-mode implementation:
   ```typescript
   function analyzeImportsFromFiles(
     files: DiffFile[],
     projectDir: string,
   ): ImportAnalysis {
     const nodeModulesDir = path.join(projectDir, "node_modules");
     const hallucinations: ImportRef[] = [];
     let skippedImports = 0;
     let checkedImports = 0;
     let validImports = 0;
     let totalImports = 0;

     // Track seen packages to avoid duplicate validation (but keep per-file attribution)
     const validatedPackages = new Map<string, { valid: boolean; reason?: string; suggestion?: string }>();

     for (const file of files) {
       const sources = extractImports(file.content);
       totalImports += sources.length;

       for (const source of sources) {
         if (shouldSkip(source)) {
           skippedImports++;
           continue;
         }

         checkedImports++;
         const { packageName, subpath } = parsePackageName(source);

         // Check cache
         const cached = validatedPackages.get(source);
         if (cached !== undefined) {
           if (cached.valid) {
             validImports++;
           } else {
             hallucinations.push({
               raw: source,
               packageName,
               subpath,
               valid: false,
               reason: cached.reason,
               suggestion: cached.suggestion,
               file: file.path,
             });
           }
           continue;
         }

         // Validate (same logic as plan mode)
         const pkgJsonPath = path.join(nodeModulesDir, packageName, "package.json");
         if (!fs.existsSync(pkgJsonPath)) {
           if (isListedDependency(packageName, projectDir)) {
             validImports++;
             validatedPackages.set(source, { valid: true });
             continue;
           }
           const suggestion = suggestPackage(packageName, nodeModulesDir);
           hallucinations.push({
             raw: source, packageName, subpath, valid: false,
             reason: "package-not-found", suggestion, file: file.path,
           });
           validatedPackages.set(source, { valid: false, reason: "package-not-found", suggestion });
           continue;
         }

         if (subpath) {
           try {
             const validSubpaths = resolvePackageExports(pkgJsonPath);
             if (validSubpaths !== null && !matchSubpath(subpath, validSubpaths)) {
               const available = [...validSubpaths]
                 .filter(s => s !== ".").map(s => s.replace(/^\.\//, "")).slice(0, 5);
               const suggestion = available.length > 0 ? `available: ${available.join(", ")}` : undefined;
               hallucinations.push({
                 raw: source, packageName, subpath, valid: false,
                 reason: "subpath-not-exported", suggestion, file: file.path,
               });
               validatedPackages.set(source, { valid: false, reason: "subpath-not-exported", suggestion });
               continue;
             }
           } catch {
             // Parse error — skip subpath validation
           }
         }

         validImports++;
         validatedPackages.set(source, { valid: true });
       }
     }

     const denominator = checkedImports;
     return {
       totalImports,
       checkedImports,
       validImports,
       hallucinations,
       hallucinationRate: denominator > 0 ? hallucinations.length / denominator : 0,
       skippedImports,
     };
   }
   ```

Note: `shouldSkip`, `parsePackageName`, `resolvePackageExports`, `matchSubpath`, `isListedDependency`, and `suggestPackage` are already module-scoped functions — no changes needed, they're available to the new function.

**Step 4: Update checkers/imports.ts**

Modify `src/analysis/checkers/imports.ts` to set `supportsSourceMode: true` and handle both input modes:

```typescript
import { registerChecker, type CheckerResult, type CheckerInput } from "../registry.js";
import { analyzeImports, type ImportAnalysis } from "../import-checker.js";

registerChecker({
  id: "imports",
  displayName: "Imports",
  catchKey: "imports",
  supportsSourceMode: true,

  run(input: CheckerInput, projectDir): CheckerResult {
    const analysis = input.mode === "source" && input.files
      ? analyzeImports(input.files, projectDir, { mode: "source" })
      : analyzeImports(input.text, projectDir);

    return {
      checkerId: "imports",
      checked: analysis.checkedImports,
      hallucinated: analysis.hallucinations.length,
      hallucinations: analysis.hallucinations.map(h => ({
        raw: h.file ? `${h.raw} (in ${h.file})` : h.raw,
        category: h.reason ?? "unknown",
        suggestion: h.suggestion,
      })),
      catchItems: analysis.hallucinations.map(h => h.raw),
      applicable: analysis.checkedImports > 0,
      notApplicableReason: analysis.checkedImports > 0 ? undefined : "No package import refs found",
      rawAnalysis: analysis,
    };
  },

  // formatForCheckAll and formatForFindings unchanged
  formatForCheckAll(result): string[] {
    // ... existing code unchanged
  },

  formatForFindings(result): string | undefined {
    // ... existing code unchanged
  },
});
```

**Step 5: Run tests to verify**

Run: `cd C:/Users/zachd/arthur && npx vitest run tests/import-source-mode.test.ts`
Expected: ALL PASS

Run: `cd C:/Users/zachd/arthur && npx vitest run`
Expected: ALL PASS (existing tests still work)

**Step 6: Commit**

```bash
git add src/analysis/import-checker.ts src/analysis/checkers/imports.ts tests/import-source-mode.test.ts
git commit -m "Add source mode to import checker with per-file attribution"
```

---

### Task 4: CLI --diff flag

**Files:**
- Modify: `bin/arthur.ts`
- Modify: `src/commands/check.ts`

**Step 1: Write the failing test**

Add to `tests/check-command.test.ts`:

```typescript
import { resolveDiffFiles } from "../src/diff/resolver.js";

describe("runCheck — diff mode", () => {
  let repoDir: string;

  beforeEach(() => {
    // Create temp git repo
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "arthur-check-diff-"));
    execSync("git init", { cwd: repoDir });
    execSync('git config user.name "Test"', { cwd: repoDir });
    execSync('git config user.email "test@test.com"', { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "index.ts"), 'export const x = 1;\n');
    // Create a minimal package.json so import checker can validate
    fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({
      name: "test",
      dependencies: { "chalk": "^5.0.0" },
    }));
    execSync("git add -A", { cwd: repoDir });
    execSync('git commit -m "init"', { cwd: repoDir });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns 0 when diff has valid imports", async () => {
    fs.writeFileSync(path.join(repoDir, "app.ts"), 'import chalk from "chalk";\n');
    execSync("git add app.ts", { cwd: repoDir });

    const code = await runCheck({ diff: "HEAD", project: repoDir });
    expect(code).toBe(0);
  });

  it("returns 1 when diff has hallucinated imports", async () => {
    fs.writeFileSync(path.join(repoDir, "app.ts"), 'import banana from "nonexistent-banana-pkg";\n');
    execSync("git add app.ts", { cwd: repoDir });

    const code = await runCheck({ diff: "HEAD", project: repoDir });
    expect(code).toBe(1);
  });

  it("errors when --diff and --plan both provided", async () => {
    const code = await runCheck({ diff: "HEAD", plan: "plan.md", project: repoDir });
    expect(code).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Cannot use --diff and --plan together"),
    );
  });

  it("supports --staged flag", async () => {
    fs.writeFileSync(path.join(repoDir, "staged.ts"), 'import chalk from "chalk";\n');
    execSync("git add staged.ts", { cwd: repoDir });

    const code = await runCheck({ diff: "HEAD", staged: true, project: repoDir });
    expect(code).toBe(0);
  });

  it("json format works in diff mode", async () => {
    fs.writeFileSync(path.join(repoDir, "app.ts"), 'import banana from "nonexistent-banana-pkg";\n');
    execSync("git add app.ts", { cwd: repoDir });

    const code = await runCheck({ diff: "HEAD", project: repoDir, format: "json" });
    expect(code).toBe(1);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const report = JSON.parse(output);
    expect(report.schemaVersion).toBe("1.0");
    expect(report.summary.totalFindings).toBeGreaterThan(0);
  });
});
```

Add `import { execSync } from "node:child_process";` at the top of the test file.

**Step 2: Run test to verify it fails**

Run: `cd C:/Users/zachd/arthur && npx vitest run tests/check-command.test.ts`
Expected: FAIL — `diff` and `staged` options not recognized

**Step 3: Update src/commands/check.ts**

Add to `CheckOptions`:
```typescript
export interface CheckOptions {
  plan?: string;
  stdin?: boolean;
  project?: string;
  format?: "text" | "json";
  schema?: string;
  includeExperimental?: boolean;
  strict?: boolean;
  minCheckedRefs?: number;
  coverageMode?: CoverageMode;
  diff?: string;    // NEW: git ref to diff against
  staged?: boolean; // NEW: use --staged
}
```

Update `runCheck` to branch on diff mode early:

```typescript
import { resolveDiffFiles } from "../diff/resolver.js";
import type { CheckerInput } from "../analysis/registry.js";

export async function runCheck(opts: CheckOptions): Promise<number> {
  // Mutual exclusion
  if (opts.diff && opts.plan) {
    console.error(chalk.red("Error: Cannot use --diff and --plan together."));
    return 1;
  }

  const projectDir = path.resolve(opts.project ?? ".");
  if (!fs.existsSync(projectDir)) {
    console.error(chalk.red(`Error: project directory not found: ${projectDir}`));
    return 1;
  }

  let input: CheckerInput;

  if (opts.diff) {
    // Diff mode: resolve files from git
    try {
      const files = resolveDiffFiles(projectDir, opts.diff, { staged: opts.staged });
      if (files.length === 0) {
        console.log(chalk.green("No changed source files found in diff."));
        return 0;
      }
      const text = files.map(f => f.content).join("\n");
      input = { mode: "source", text, files };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error resolving diff: ${msg}`));
      return 1;
    }
  } else {
    // Plan mode (existing behavior)
    const planText = await loadPlanText(opts);
    if (!planText) {
      // ... existing error handling unchanged
      return 1;
    }
    input = { mode: "plan", text: planText };
  }

  // 3. Run checkers (shared path)
  const options: Record<string, string> = {};
  if (opts.schema) options.schemaPath = opts.schema;
  const policy = resolveArthurCheckPolicy(projectDir, {
    includeExperimental: opts.includeExperimental,
    strict: opts.strict,
    minCheckedRefs: opts.minCheckedRefs,
    coverageMode: opts.coverageMode,
  });
  const summary = runAllCheckers(input, projectDir, {
    includeExperimental: policy.includeExperimental,
    checkerOptions: options,
  });
  // ... rest unchanged (coverage gate, output, exit code)
}
```

**Step 4: Update bin/arthur.ts**

Add `--diff` and `--staged` options to the check command:

```typescript
program
  .command("check")
  .description("Run all deterministic checkers against a plan or code diff")
  .option("--plan <file>", "Path to plan file")
  .option("--stdin", "Read plan from stdin")
  .option("--diff <ref>", "Check code changes from git diff against <ref> (e.g., HEAD, origin/main)")
  .option("--staged", "With --diff, check only staged changes")
  .option("--project <dir>", "Project directory (default: cwd)")
  // ... rest unchanged
```

**Step 5: Run tests to verify**

Run: `cd C:/Users/zachd/arthur && npx vitest run tests/check-command.test.ts`
Expected: ALL PASS

Run: `cd C:/Users/zachd/arthur && npx vitest run`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add bin/arthur.ts src/commands/check.ts tests/check-command.test.ts
git commit -m "Add --diff flag to arthur check CLI for source code verification"
```

---

### Task 5: MCP check_diff tool

**Files:**
- Modify: `bin/arthur-mcp.ts`

**Step 1: Write the check_diff tool**

Add after the `check_all` tool block (around line 1046) in `bin/arthur-mcp.ts`:

```typescript
// --- check_diff (source code verification via git diff) ---

server.tool(
  "check_diff",
  "Validate actual code changes from a git diff against project ground truth. Catches hallucinated imports in source files that were added or modified. Only checkers with source-mode support are run (currently: imports). No API key required.",
  {
    projectDir: z.string().describe("Absolute path to the project directory (must be a git repo)"),
    diffRef: z.string().optional().default("HEAD").describe("Git ref to diff against: HEAD (default), origin/main, HEAD~3, etc."),
    staged: z.boolean().optional().default(false).describe("Check only staged changes (for pre-commit hooks)"),
    format: z.enum(["text", "json"]).optional().default("text").describe("Output format: 'text' for markdown (default), 'json' for machine-readable ArthurReport"),
    includeExperimental: z.boolean().optional().describe("Include experimental checkers (if they support source mode)."),
    strict: z.boolean().optional().default(false).describe("Strict mode: includes experimental checkers and fails coverage gate."),
    minCheckedRefs: z.number().int().positive().optional().describe("Coverage gate threshold."),
    coverageMode: z.enum(["off", "warn", "fail"]).optional().describe("Coverage gate mode."),
  },
  async ({ projectDir, diffRef, staged, format, includeExperimental, strict, minCheckedRefs, coverageMode }) => {
    try {
      const files = resolveDiffFiles(projectDir, diffRef, { staged });

      if (files.length === 0) {
        return { content: [{ type: "text", text: "No changed source files found in diff." }] };
      }

      const text = files.map(f => f.content).join("\n");
      const input: CheckerInput = { mode: "source", text, files };

      const policy = resolveArthurCheckPolicy(projectDir, {
        includeExperimental,
        strict,
        minCheckedRefs,
        coverageMode,
      });

      const summary = runAllCheckers(input, projectDir, {
        includeExperimental: policy.includeExperimental,
      });
      const coverageGate = evaluateCoverageGate(
        summary.totalChecked,
        policy.minCheckedRefs,
        policy.coverageMode,
      );

      // Log catches
      const catchFindings: Record<string, { checked: number; hallucinated: number; items: string[] } | null> = {};
      for (const { checker, result } of summary.checkerResults) {
        catchFindings[checker.catchKey] = result.applicable
          ? { checked: result.checked, hallucinated: result.hallucinated, items: result.catchItems }
          : null;
      }
      logCatch({
        timestamp: new Date().toISOString(),
        tool: "check_diff",
        projectDir: path.basename(projectDir),
        findings: catchFindings,
        totalChecked: summary.totalChecked,
        totalHallucinated: summary.totalFindings,
      });

      // JSON output
      if (format === "json") {
        const report = buildJsonReport(summary.checkerResults, projectDir);
        const payload = {
          ...report,
          meta: {
            mode: "diff",
            diffRef,
            staged,
            filesChecked: files.length,
            includeExperimental: policy.includeExperimental,
            coverageGate,
            skippedCheckers: summary.skippedCheckers.map((s) => ({
              checker: s.checker.id,
              displayName: s.checker.displayName,
              reason: s.reason,
            })),
          },
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      }

      // Text (markdown) output
      const lines: string[] = [];
      lines.push(`# Arthur Diff Report`);
      lines.push(``);
      lines.push(`**Mode:** diff (${staged ? "staged" : diffRef})`);
      lines.push(`**Files checked:** ${files.length}`);
      lines.push(`**Experimental checkers:** ${policy.includeExperimental ? "enabled" : "disabled"}`);
      lines.push(``);

      for (const { checker, result } of summary.checkerResults) {
        if (result.applicable) {
          lines.push(...checker.formatForCheckAll(result, projectDir));
        }
      }

      if (summary.skippedCheckers.length > 0) {
        lines.push(`## Skipped / Not Applicable`);
        for (const skipped of summary.skippedCheckers) {
          lines.push(`- **${skipped.checker.displayName}** — ${skipped.reason}`);
        }
        lines.push(``);
      }

      // Coverage gate
      lines.push(`## Coverage Gate`);
      lines.push(`- Mode: \`${coverageGate.mode}\``);
      lines.push(`- Minimum checked refs: **${coverageGate.minCheckedRefs}**`);
      lines.push(`- Total checked refs: **${summary.totalChecked}**`);
      if (coverageGate.triggered) {
        const level = coverageGate.mode === "fail" ? "FAILED" : "WARNING";
        lines.push(`- Status: **${level}** — ${coverageGate.message}`);
      } else if (coverageGate.mode === "off") {
        lines.push(`- Status: disabled`);
      } else {
        lines.push(`- Status: pass`);
      }
      lines.push(``);

      lines.push(`---`);
      if (summary.totalFindings === 0) {
        lines.push(`**All checks passed.** No issues found in changed files.`);
      } else {
        lines.push(`**${summary.totalFindings} issue(s) found.** Fix the references above.`);
      }

      const coverageFailed = coverageGate.mode === "fail" && coverageGate.triggered;
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        ...(coverageFailed ? { isError: true } : {}),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  },
);
```

Add imports at the top of `arthur-mcp.ts`:
```typescript
import { resolveDiffFiles } from "../src/diff/resolver.js";
import type { CheckerInput } from "../src/analysis/registry.js";
```

Update the server description/tool count comment at the top of the file.

**Step 2: Build and verify**

Run: `cd C:/Users/zachd/arthur && npm run build`
Expected: PASS — no type errors

**Step 3: Smoke test the MCP tool manually**

Run: `cd C:/Users/zachd/arthur && echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npx tsx bin/arthur-mcp.ts 2>/dev/null | head -5`
Expected: tool list includes `check_diff`

**Step 4: Commit**

```bash
git add bin/arthur-mcp.ts
git commit -m "Add check_diff MCP tool for source code verification"
```

---

### Task 6: Update CLAUDE.md and docs

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update CLAUDE.md**

Add `check_diff` to the MCP tools list and update the CLI section:

In the MCP Server section, add after `check_all`:
```
- `check_diff` — runs source-mode checkers against git diff (code changes, not plans). Supports staged-only for pre-commit. No API key.
```

In the CLI section, add diff usage examples:
```
arthur check --diff HEAD --project .              # all uncommitted changes
arthur check --diff HEAD --staged --project .     # staged only (pre-commit)
arthur check --diff origin/main --project .       # CI: everything since branch point
```

Update the tool count from 12 to 13.

Mark Phase 1 `check --diff` as partially complete in the Roadmap:
```
### Phase 1: `check --diff` (code input, not just plans)
- [x] `arthur check --diff HEAD --strict .` — imports checker in source mode
- [x] `arthur check --diff --staged --strict .` — staged files
- [ ] Expand source mode to other checkers (env, routes, schema)
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "Update CLAUDE.md with check --diff documentation"
```

---

### Task 7: End-to-end integration test

**Files:**
- Create: `tests/check-diff-e2e.test.ts`

**Step 1: Write the integration test**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
import { runCheck } from "../src/commands/check.js";

// Suppress console output
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Create a realistic temp repo with node_modules for import validation.
 * Installs chalk as a real dependency.
 */
function createRepoWithDeps(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arthur-e2e-"));
  execSync("git init", { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });

  // Write package.json with a real dependency
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "test-project",
    version: "1.0.0",
    dependencies: { "chalk": "^5.0.0" },
  }));

  // Install deps
  execSync("npm install --silent", { cwd: dir, timeout: 30000 });

  fs.writeFileSync(path.join(dir, "index.ts"), 'export const x = 1;\n');
  execSync("git add -A", { cwd: dir });
  execSync('git commit -m "init"', { cwd: dir });

  return dir;
}

describe("check --diff end-to-end", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createRepoWithDeps();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("passes when new file imports an installed package", async () => {
    fs.writeFileSync(
      path.join(repoDir, "src/app.ts"),
      'import chalk from "chalk";\nconsole.log(chalk.green("ok"));\n',
    );
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, "src/app.ts"),
      'import chalk from "chalk";\nconsole.log(chalk.green("ok"));\n',
    );
    execSync("git add -A", { cwd: repoDir });

    const code = await runCheck({ diff: "HEAD", project: repoDir });
    expect(code).toBe(0);
  });

  it("fails when new file imports a nonexistent package", async () => {
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, "src/app.ts"),
      'import nonexistent from "totally-fake-package-xyz";\n',
    );
    execSync("git add -A", { cwd: repoDir });

    const code = await runCheck({ diff: "HEAD", project: repoDir });
    expect(code).toBe(1);
  });

  it("text output shows diff mode context", async () => {
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, "src/app.ts"),
      'import chalk from "chalk";\n',
    );
    execSync("git add -A", { cwd: repoDir });

    await runCheck({ diff: "HEAD", project: repoDir, format: "text" });
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0])
      .join("\n");
    expect(output).toContain("Arthur Verification Report");
  });
});
```

**Step 2: Run test**

Run: `cd C:/Users/zachd/arthur && npx vitest run tests/check-diff-e2e.test.ts`
Expected: ALL PASS

**Step 3: Run full test suite**

Run: `cd C:/Users/zachd/arthur && npx vitest run`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add tests/check-diff-e2e.test.ts
git commit -m "Add end-to-end integration tests for check --diff"
```
