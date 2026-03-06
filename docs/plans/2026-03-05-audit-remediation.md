# Audit Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> **Implementation skills:** @typescript-pro, @mcp-developer, @cli-developer, @secure-code-guardian, @test-master

**Goal:** Address all findings from the March 2026 technical audit, prioritized by severity and blast radius.

**Architecture:** Fix security/correctness bugs first (stale caches, git stderr leak, regex issues), then refactor the MCP monolith to eliminate formatting duplication, then fix tests, then address benchmark methodology. Each phase is independently shippable.

**Tech Stack:** TypeScript, Node.js, MCP SDK, Vitest, Commander CLI

**Audit status after investigation:**
- Critical #1 (command injection): **Already fixed** — code uses `execFileSync("git", args)` array form, not `execSync` string concatenation
- Critical #2 (stale caches): Confirmed
- Important #3-7: Confirmed
- Test #8-10: Confirmed

**Pre-mortem adjustments applied:**
- Merged Tasks 1+14: request-scoped caching is the P0 fix (not "sprinkle more clear calls")
- Task 5: benchmark existing regex first, use minimal `[^}]*` fix if fast enough (avoid full parser rewrite)
- Task 6: add `formatForCli()` to CheckerDefinition instead of discriminated union in registry (avoids circular deps)
- Task 6: also covers `run-all.ts` inferSkipReason anti-pattern
- Reordered: MCP snapshot tests (Task 7) come BEFORE MCP refactor (Task 8)

---

## Phase 1: Security & Correctness Bugs

### Task 1: Fix stale caches with request-scoped caching

The MCP server is long-running. `depsCache` (import-checker.ts:248) and `apiCache` (package-api-checker.ts:332) are module-level Maps that persist across requests. The structural fix: pass a request-scoped cache via `CheckerInput` so caches are created fresh per invocation and garbage-collected automatically. Also clear module-level caches as a belt-and-suspenders measure.

**Files:**
- Modify: `src/analysis/registry.ts` — add `fileCache` to `CheckerInput`
- Modify: `src/analysis/run-all.ts` — create and pass request-scoped cache, clear module caches
- Modify: `src/analysis/import-checker.ts` — use request-scoped cache instead of module-level
- Modify: `src/analysis/package-api-checker.ts` — use request-scoped cache instead of module-level
- Modify: `bin/arthur-mcp.ts` — clear module caches before individual tool invocations
- Test: `tests/cache-invalidation.test.ts`

**Step 1: Write failing test for stale cache behavior**

```typescript
import { describe, it, expect } from "vitest";
import { clearImportCaches } from "../src/analysis/import-checker.js";
import { clearApiCaches } from "../src/analysis/package-api-checker.js";

describe("cache invalidation", () => {
  it("clearImportCaches resets depsCache", () => {
    clearImportCaches();
    // Verify no stale data persists
  });

  it("clearApiCaches resets apiCache", () => {
    clearApiCaches();
  });
});
```

**Step 2: Run test to verify it passes (baseline)**

Run: `cd /c/Users/zachd/arthur && npx vitest run tests/cache-invalidation.test.ts`

**Step 3: Add fileCache to CheckerInput**

In `src/analysis/registry.ts`:
```typescript
export interface CheckerInput {
  mode: "plan" | "source";
  text: string;
  files?: DiffFile[];
  /** Request-scoped cache shared across checkers in a single run. Avoids stale module-level caches. */
  cache?: Map<string, unknown>;
}
```

**Step 4: In runAllCheckers, create and pass the cache + clear module caches**

In `src/analysis/run-all.ts`:
```typescript
import { clearImportCaches } from "./import-checker.js";
import { clearApiCaches } from "./package-api-checker.js";

export function runAllCheckers(input: CheckerInput, projectDir: string, options: RunAllOptions = {}): CheckerRunSummary {
  // Clear stale module-level caches
  clearImportCaches();
  clearApiCaches();

  // Create request-scoped cache
  const scopedInput: CheckerInput = { ...input, cache: input.cache ?? new Map() };

  // ... existing loop uses scopedInput instead of input
}
```

**Step 5: Update import-checker and package-api-checker to prefer request-scoped cache**

Each checker should check `input.cache` first, fall back to module-level cache, and store results in `input.cache` when available.

**Step 6: Add cache clearing to individual MCP tool handlers**

In `bin/arthur-mcp.ts`, at the top of each individual tool handler (check_imports, check_package_api):
```typescript
clearImportCaches();
clearApiCaches();
```

**Step 7: Verify all existing tests still pass**

Run: `cd /c/Users/zachd/arthur && npx vitest run`

**Step 8: Commit**

```bash
git add src/analysis/registry.ts src/analysis/run-all.ts src/analysis/import-checker.ts src/analysis/package-api-checker.ts bin/arthur-mcp.ts tests/cache-invalidation.test.ts
git commit -m "fix: add request-scoped caching to eliminate stale module-level cache bug"
```

---

### Task 2: Sanitize git stderr in error messages

Git errors from `resolveDiffFiles` propagate system paths through MCP protocol responses (Important #6). The error at the catch block includes `projectDir`.

**Files:**
- Modify: `src/diff/resolver.ts:43-45`
- Modify: `tests/diff-resolver.test.ts`

**Step 1: Write failing test**

```typescript
// In tests/diff-resolver.test.ts, add:
it("does not leak system paths in error messages", () => {
  expect(() => resolveDiffFiles("/some/private/path", "nonexistent-ref")).toThrow();
  try {
    resolveDiffFiles("/some/private/path", "nonexistent-ref");
  } catch (e: any) {
    expect(e.message).not.toContain("/some/private/path");
  }
});
```

**Step 2: Run test to verify it fails**

Run: `cd /c/Users/zachd/arthur && npx vitest run tests/diff-resolver.test.ts`
Expected: FAIL — current error message includes projectDir

**Step 3: Fix error message to omit system paths**

In `src/diff/resolver.ts`, change the catch block:
```typescript
} catch {
  throw new Error(`git diff failed for ref "${diffRef}"`);
}
```

**Step 4: Run test to verify it passes**

Run: `cd /c/Users/zachd/arthur && npx vitest run tests/diff-resolver.test.ts`

**Step 5: Commit**

```bash
git add src/diff/resolver.ts tests/diff-resolver.test.ts
git commit -m "fix: sanitize git error messages to prevent system path leakage"
```

---

### Task 3: Fix SQL column extraction comma splitting

`extractSqlColumns` at sql-schema-checker.ts:206 splits on all commas, which breaks on CHECK constraints or defaults with embedded commas.

**Files:**
- Modify: `src/analysis/sql-schema-checker.ts:205-206`
- Test: `tests/sql-schema-checker.test.ts`

**Step 1: Write failing test**

```typescript
import { describe, it, expect } from "vitest";
// Import the internal function (may need to export for testing)

describe("extractSqlColumns", () => {
  it("handles CHECK constraints with embedded commas", () => {
    const sql = `CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  status VARCHAR(50) CHECK (status IN ('active', 'inactive')),
  name TEXT NOT NULL
);`;
    const columns = extractSqlColumns(sql);
    expect(columns.map(c => c.name)).toEqual(["id", "status", "name"]);
  });

  it("handles DEFAULT values with embedded commas", () => {
    const sql = `CREATE TABLE logs (
  id INTEGER PRIMARY KEY,
  metadata TEXT DEFAULT '{"a": 1, "b": 2}',
  created_at TIMESTAMP
);`;
    const columns = extractSqlColumns(sql);
    expect(columns.map(c => c.name)).toEqual(["id", "metadata", "created_at"]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /c/Users/zachd/arthur && npx vitest run tests/sql-schema-checker.test.ts`

**Step 3: Replace naive comma split with paren/quote-aware splitting**

Replace the `body.split(",")` at line 206 with a depth-aware splitter:
```typescript
function splitColumnsAware(body: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let inString = false;
  let stringChar = "";

  for (const ch of body) {
    if (inString) {
      current += ch;
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      current += ch;
      continue;
    }
    if (ch === "(") { depth++; current += ch; continue; }
    if (ch === ")") { depth--; current += ch; continue; }
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}
```

**Step 4: Run test to verify it passes**

Run: `cd /c/Users/zachd/arthur && npx vitest run tests/sql-schema-checker.test.ts`

**Step 5: Commit**

```bash
git add src/analysis/sql-schema-checker.ts tests/sql-schema-checker.test.ts
git commit -m "fix: use paren/quote-aware splitting for SQL column extraction"
```

---

### Task 4: Fix Supabase findNearestFrom regex

The regex at supabase-schema-checker.ts:290 uses `(?!.*\.from\()` which doesn't reliably find the last `.from()` call due to `.` not crossing newlines.

**Files:**
- Modify: `src/analysis/supabase-schema-checker.ts:280-291`
- Test: `tests/supabase-schema-checker.test.ts`

**Step 1: Write failing test**

```typescript
describe("findNearestFrom", () => {
  it("finds the correct table when two .from() calls are on the same line", () => {
    const plan = `const a = supabase.from('users').select(); const b = supabase.from('orders').select('status')`;
    const position = plan.indexOf("'status'");
    const result = findNearestFrom(plan, position);
    expect(result).toBe("orders");
  });
});
```

**Step 2: Run test to verify it fails**

**Step 3: Replace regex approach with findAll-take-last**

```typescript
function findNearestFrom(planText: string, position: number): string | undefined {
  const start = Math.max(0, position - 500);
  const beforeText = planText.slice(start, position);

  const lastBlankLine = beforeText.lastIndexOf("\n\n");
  const searchText = lastBlankLine >= 0 ? beforeText.slice(lastBlankLine) : beforeText;

  // Find ALL .from() calls and take the last one
  const fromRegex = /\.from\(\s*["'](\w+)["']\s*\)/g;
  let lastMatch: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = fromRegex.exec(searchText)) !== null) {
    lastMatch = m[1];
  }
  return lastMatch;
}
```

**Step 4: Run test to verify it passes**

**Step 5: Commit**

```bash
git add src/analysis/supabase-schema-checker.ts tests/supabase-schema-checker.test.ts
git commit -m "fix: findNearestFrom now correctly finds last .from() call"
```

---

### Task 5: Assess and fix Prisma model regex backtracking risk

The regex at schema-checker.ts:63 (`/^model\s+(\w+)\s*\{([\s\S]*?)^}/gm`) could exhibit catastrophic backtracking. **Benchmark first before rewriting.**

**Files:**
- Modify: `src/analysis/schema-checker.ts:63` (only if benchmark shows issue)
- Test: `tests/schema-checker.test.ts`

**Step 1: Write benchmark test**

```typescript
describe("parseSchema", () => {
  it("handles large Prisma schemas without timeout", () => {
    let schema = "";
    for (let i = 0; i < 100; i++) {
      schema += `model Model${i} {\n`;
      for (let j = 0; j < 20; j++) {
        schema += `  field${j} String\n`;
      }
      schema += `}\n\n`;
    }
    const start = Date.now();
    const result = parseSchema(schema);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(result.models.size).toBe(100);
  });
});
```

**Step 2: Run benchmark test**

Run: `cd /c/Users/zachd/arthur && npx vitest run tests/schema-checker.test.ts`

**Step 3: If test passes (likely <100ms), apply minimal regex fix**

Replace `[\s\S]*?` with `[^}]*` — Prisma model bodies don't contain bare `}` on a line (fields use `@` attributes, not braces). This eliminates the backtracking path without rewriting the parser:

```typescript
const modelRegex = /^model\s+(\w+)\s*\{([^}]*)^}/gm;
```

If this breaks existing tests (e.g., models with `}` in comments), then fall back to `[\s\S]*?` and document as accepted risk for schemas <10K lines.

**Step 4: Run all tests**

Run: `cd /c/Users/zachd/arthur && npx vitest run`

**Step 5: Commit**

```bash
git add src/analysis/schema-checker.ts tests/schema-checker.test.ts
git commit -m "fix: reduce Prisma regex backtracking risk with constrained character class"
```

---

## Phase 2: Type Safety & Registry

### Task 6: Eliminate as-any casts via formatForCli on CheckerDefinition

Instead of importing concrete analysis types into `registry.ts` (which creates circular dependencies), add a `formatForCli()` method to `CheckerDefinition`. Each checker knows its own types and formats its own CLI output. This eliminates the manual checker ID switch in `verify.ts` AND `run-all.ts`.

**Files:**
- Modify: `src/analysis/registry.ts` — add `formatForCli` to CheckerDefinition
- Modify: `src/analysis/checkers/*.ts` — each checker implements `formatForCli` (move logic from formatter.ts print functions)
- Modify: `src/commands/verify.ts:117-142` — replace switch with `checker.formatForCli(result)`
- Modify: `src/analysis/run-all.ts:34-70` — eliminate `inferSkipReason` by having each checker provide its own skip reason in `notApplicableReason`
- Modify: `src/analysis/formatter.ts` — remove per-checker print functions (now on checker definitions)

**Step 1: Add formatForCli to CheckerDefinition**

In `src/analysis/registry.ts`:
```typescript
export interface CheckerDefinition {
  // ... existing fields
  /** Format result for CLI text output (colored, verbose). */
  formatForCli(result: CheckerResult, projectDir: string): void;
}
```

**Step 2: Move each printXAnalysis function from formatter.ts into the corresponding checker**

For example, `printSchemaAnalysis()` moves into `src/analysis/checkers/schema.ts` as the `formatForCli` method. The checker knows its own `rawAnalysis` type internally — no cast needed.

**Step 3: Update verify.ts to use formatForCli**

Replace the manual switch:
```typescript
for (const { checker, result } of summary.checkerResults) {
  if (!result.applicable) continue;
  checker.formatForCli(result, projectDir);
}
```

**Step 4: Ensure each checker sets notApplicableReason in its run() method**

Then remove `inferSkipReason` from `run-all.ts` — each checker already knows why it's not applicable. The existing `notApplicableReason` field on `CheckerResult` (line 28) is already there, just underused.

**Step 5: Verify compilation**

Run: `cd /c/Users/zachd/arthur && npm run build`

**Step 6: Run tests**

Run: `cd /c/Users/zachd/arthur && npx vitest run`

**Step 7: Commit**

```bash
git add src/analysis/registry.ts src/analysis/checkers/ src/commands/verify.ts src/analysis/run-all.ts src/analysis/formatter.ts
git commit -m "refactor: add formatForCli to CheckerDefinition, eliminate as-any casts and inferSkipReason"
```

---

## Phase 3: MCP Server Refactor

### Task 7: Write MCP snapshot tests BEFORE refactoring

The MCP server's individual tools have different formatting than `formatForCheckAll()` — different section titles, suggestion formats, ground truth detail levels. Capture current behavior in tests before changing anything.

**Files:**
- Create: `tests/mcp-tools.test.ts`

**Step 1: Write snapshot/approval tests for each MCP tool**

```typescript
import { describe, it, expect } from "vitest";
// Import analysis functions directly (same as MCP tools call them)

describe("MCP tool output", () => {
  describe("check_paths", () => {
    it("matches expected output for hallucinated paths", () => {
      // Run path checker against fixture-a with a plan referencing nonexistent files
      // Snapshot the formatted output
    });
    it("matches expected output for valid paths", () => {
      // Clean plan
    });
  });

  describe("check_all", () => {
    it("returns findings for a plan with hallucinated paths", () => {});
    it("returns clean report for a valid plan", () => {});
    it("respects strict mode", () => {});
  });

  describe("check_diff", () => {
    it("validates imports in changed files", () => {});
  });

  // Cover each individual tool: check_schema, check_imports, check_env,
  // check_types, check_routes, check_sql_schema, check_supabase_schema,
  // check_express_routes, check_package_api
});
```

**Step 2: Run tests and generate snapshots**

Run: `cd /c/Users/zachd/arthur && npx vitest run tests/mcp-tools.test.ts --update`

**Step 3: Review snapshots for correctness**

**Step 4: Commit**

```bash
git add tests/mcp-tools.test.ts tests/__snapshots__/
git commit -m "test: add MCP tool snapshot tests to protect against refactor regressions"
```

---

### Task 8: Eliminate individual tool formatting duplication

Now that snapshot tests protect current behavior, move individual tool formatting into `formatForTool()` on each checker.

**Files:**
- Modify: `src/analysis/registry.ts` — add `formatForTool(result, projectDir): string` to CheckerDefinition
- Modify: `src/analysis/checkers/*.ts` — implement `formatForTool` (move individual tool formatting here)
- Modify: `bin/arthur-mcp.ts` — replace inline formatting with `checker.formatForTool(result, projectDir)`

**Step 1: Add formatForTool to CheckerDefinition interface**

```typescript
export interface CheckerDefinition {
  // ... existing fields
  /** Format result for an individual MCP tool response (verbose, with ground truth). */
  formatForTool(result: CheckerResult, projectDir: string): string;
}
```

**Step 2: For each checker, extract the individual tool formatting from arthur-mcp.ts into the checker registration**

Start with one checker (e.g., env) as a pattern:
- Copy the formatting logic from the check_env handler in arthur-mcp.ts
- Move it into the env checker's `formatForTool()` method in `src/analysis/checkers/env.ts`
- Update the MCP handler to call `checker.formatForTool(result, projectDir)`

**Step 3: Repeat for all 10 checkers**

Each checker's individual MCP tool handler should shrink to:
```typescript
if (request.params.name === "check_env") {
  const checker = getChecker("env");
  const result = checker.run(input, projectDir, options);
  logCatch(...);
  return { content: [{ type: "text", text: checker.formatForTool(result, projectDir) }] };
}
```

**Step 4: Run snapshot tests to verify output is preserved**

Run: `cd /c/Users/zachd/arthur && npx vitest run tests/mcp-tools.test.ts`

**Step 5: Run all tests**

Run: `cd /c/Users/zachd/arthur && npx vitest run`

**Step 6: Commit**

```bash
git add bin/arthur-mcp.ts src/analysis/registry.ts src/analysis/checkers/
git commit -m "refactor: move individual tool formatting into checker registry, eliminate MCP duplication"
```

---

### Task 9: Extract MCP tool handlers into separate module

After Task 8, the MCP server should be significantly smaller. Extract the remaining tool handler registration into a separate module.

**Files:**
- Create: `src/mcp/tool-handlers.ts` — tool registration logic
- Modify: `bin/arthur-mcp.ts` — import and call registration function

**Step 1: Create src/mcp/tool-handlers.ts**

Move the `server.setRequestHandler("tools/call", ...)` and `server.setRequestHandler("tools/list", ...)` into a function:
```typescript
export function registerToolHandlers(server: Server): void {
  // tool list handler
  // tool call handler with switch/if for each tool
}
```

**Step 2: Slim down arthur-mcp.ts**

```typescript
import { registerToolHandlers } from "../src/mcp/tool-handlers.js";
const server = new Server(...);
registerToolHandlers(server);
server.listen();
```

**Step 3: Run all tests**

Run: `cd /c/Users/zachd/arthur && npx vitest run`

**Step 4: Commit**

```bash
git add bin/arthur-mcp.ts src/mcp/tool-handlers.ts
git commit -m "refactor: extract MCP tool handlers into separate module"
```

---

## Phase 4: Test Fixes

### Task 10: Fix fixture-f reference in package-api-checker tests

Tests reference `bench/fixtures/fixture-f` which doesn't exist. Tests pass only because zod is in a parent `node_modules`.

**Files:**
- Create: `bench/fixtures/fixture-f/package.json` — minimal fixture with zod dependency
- Modify: `tests/package-api-checker.test.ts` — verify fixture path works

**Step 1: Read the test file to understand what fixture-f needs**

Read `tests/package-api-checker.test.ts` to see what the tests expect from fixture-f.

**Step 2: Create fixture-f with the required structure**

At minimum:
```json
{
  "name": "fixture-f",
  "dependencies": {
    "zod": "^4.0.0"
  }
}
```

May also need a `node_modules/zod/` with `.d.ts` files or a symlink to the root `node_modules/zod`.

**Step 3: Run tests**

Run: `cd /c/Users/zachd/arthur && npx vitest run tests/package-api-checker.test.ts`

**Step 4: Commit**

```bash
git add bench/fixtures/fixture-f/ tests/package-api-checker.test.ts
git commit -m "fix: create missing fixture-f for package-api-checker tests"
```

---

### Task 11: Fix hardcoded "master" branch in diff-resolver tests

Test at diff-resolver.test.ts:122 hardcodes "master" branch name.

**Files:**
- Modify: `tests/diff-resolver.test.ts:115-125`

**Step 1: Read current test to understand setup**

The test creates a git repo with `git init`, which uses the system default branch name.

**Step 2: Fix to detect default branch name**

```typescript
it("supports diff against a branch ref", () => {
  const defaultBranch = execSync("git branch --show-current", { cwd: tmpDir, encoding: "utf-8" }).trim();
  git("checkout -b feature");
  writeFile("src/feature.ts", "export const feat = true;\n");
  git("add .");
  git('commit -m "feature commit"');

  const files = resolveDiffFiles(tmpDir, defaultBranch);
  expect(files).toHaveLength(1);
  expect(files[0].path).toBe("src/feature.ts");
});
```

**Step 3: Run test**

Run: `cd /c/Users/zachd/arthur && npx vitest run tests/diff-resolver.test.ts`

**Step 4: Commit**

```bash
git add tests/diff-resolver.test.ts
git commit -m "fix: detect default branch name instead of hardcoding master"
```

---

## Phase 5: Benchmark Methodology (Documentation)

### Task 12: Revise benchmark claims and methodology docs

This is primarily documentation work, not code. Address the audit's D+ benchmark verdict.

**Files:**
- Modify: `README.md` — revise headline claims
- Modify: `CLAUDE.md` — update benchmark descriptions
- Create or modify: `bench/METHODOLOGY.md` — document limitations transparently

**Step 1: Remove "100% vs 21%" headline framing**

Replace with honest framing: "Arthur uses deterministic filesystem checks that catch reference errors self-review misses. Effectiveness varies by codebase and task type."

**Step 2: Document known limitations explicitly**

- Single-run results without confidence intervals
- Adversarially constructed fixtures (stress test, not representative)
- Curated tasks, not randomly sampled
- Package API false positive rate (54% for React re-exports)
- Self-review comparison uses different information access levels

**Step 3: Add reproducibility instructions**

- Document how to run benchmarks
- Remove hardcoded Windows paths from any user-facing docs
- Note which benchmarks require external projects

**Step 4: Commit**

```bash
git add README.md CLAUDE.md bench/METHODOLOGY.md
git commit -m "docs: revise benchmark claims with transparent methodology limitations"
```

---

## Phase 6: Cleanup

### Task 13: Unify config systems

The audit flags dual config systems (`~/.codeverifier/` vs `.arthur/config.json`). This is a UX issue.

**Files:**
- Modify: `src/config/manager.ts`
- Modify: `CLAUDE.md` — update config documentation

**Step 1: Decide on canonical config location**

`.arthur/config.json` for project config, `~/.arthur/config.json` for global. Deprecate `~/.codeverifier/` with a migration message.

**Step 2: Add migration logic**

If `~/.codeverifier/` exists and `~/.arthur/` doesn't, read from old location and print a deprecation warning.

**Step 3: Update docs**

**Step 4: Commit**

```bash
git add src/config/manager.ts CLAUDE.md
git commit -m "refactor: unify config to .arthur/ with codeverifier migration path"
```

---

## Execution Order

| Priority | Tasks | Why |
|----------|-------|-----|
| P0 | 1, 2 | Security & correctness — stale caches cause wrong results, path leakage |
| P1 | 3, 4, 5 | Correctness — regex/parsing bugs cause false positives |
| P2 | 6 | Type safety — eliminate as-any casts without circular deps |
| P3 | 7, 8, 9 | MCP refactor — snapshot tests first, then refactor, then extract |
| P4 | 10, 11 | Test hygiene — broken fixtures, hardcoded branch |
| P5 | 12 | Credibility — benchmark methodology transparency |
| P6 | 13 | Polish — config UX |
