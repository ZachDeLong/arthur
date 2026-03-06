# Audit Remediation v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> **Implementation skills:** @typescript-pro, @mcp-developer, @cli-developer, @secure-code-guardian, @test-master

**Goal:** Fix the core problems identified in the second audit: broken regex parsing in package-api-checker, structurally misleading benchmark claims, a dead-weight 98% FP type-checker, silent error swallowing, and missing precision tests.

**Architecture:** Three phases. Phase 1 fixes the fundamentally broken things (parser, type-checker removal, benchmark honesty). Phase 2 fixes correctness/security issues (caching, error logging, input validation, false positive tests). Phase 3 is the polish we already had planned. Every task is independently shippable.

**Tech Stack:** TypeScript, Node.js, MCP SDK, Vitest, Commander CLI

**Problem summary from the audit deep-dive:**
- `package-api-checker.ts` uses `[\s\S]*?` regex to parse class/interface bodies — fails on nested generics like `class Foo<T extends { x: number }>` because the regex matches the inner `}` instead of the real closing brace
- `type-checker.ts` has a 98% false positive rate, is disabled everywhere, and its only consumers are: (a) its own MCP tool `check_types`, (b) its checker registration, (c) `package-api-checker.ts` which imports `parseObjectMembers`/`parseClassMembers`
- README tables show "Arthur 100%" which is tautological — Arthur defines its own ground truth
- Tier 4 benchmark gives Arthur full filesystem but self-review only CLAUDE.md — the "79pp gap" is partly an information asymmetry, not a method comparison
- 54% of package API errors in Tier 4 are React re-exports (false positives) counted in headline numbers
- 17 MCP catch blocks silently swallow errors
- `CheckerInput.cache` exists but no checker uses it
- No false positive regression tests exist
- `diffRef` and stdin have no input validation
- `express-route-checker.ts` constructs regexes with unescaped variable names

---

## Phase 1: Fix the Fundamentally Broken Things

### Task 1: Replace regex body parsing with brace-tracking in package-api-checker

The interface/class body extraction at `package-api-checker.ts:427-442` uses regex:
```typescript
const interfaceRegex = /^(?:export\s+(?:declare\s+)?)?interface\s+(\w+)(?:\s+extends\s+[\w\s,<>]+)?\s*\{([\s\S]*?)^\}/gm;
const classRegex = /^(?:export\s+(?:declare\s+)?)?(?:abstract\s+)?class\s+(\w+)(?:\s+(?:extends|implements)[\s\S]*?)?\s*\{([\s\S]*?)^\}/gm;
```

This breaks on nested braces in generics: `interface Foo<T extends { bar: number }>` — the `[\s\S]*?` lazy match terminates at the first `^}` which could be inside the generic constraint, not the actual closing brace.

The fix: use the same manual brace-tracking approach that `supabase-schema-checker.ts` already uses successfully (its `extractBraceBlock()` function). Find the opening `{` after the declaration keyword, then count brace depth to find the matching `}`.

**Files:**
- Modify: `src/analysis/package-api-checker.ts:425-442`
- Create: `tests/package-api-brace-tracking.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { parseExportedApi } from "../src/analysis/package-api-checker.js";

describe("brace-tracking for nested generics", () => {
  it("parses interface with nested generic constraint", () => {
    const content = [
      "export declare interface Container<T extends { id: number }> {",
      "  items: T[];",
      "  getItem(id: number): T;",
      "}",
      "",
      "export declare function create(): Container<any>;",
    ].join("\n");

    const api = parseExportedApi(content, "/fake/index.d.ts", "/fake");
    expect(api.exports.has("Container")).toBe(true);
    expect(api.exports.has("create")).toBe(true);
    const members = api.membersByExport.get("Container");
    expect(members).toBeDefined();
    expect(members!.has("items")).toBe(true);
    expect(members!.has("getItem")).toBe(true);
  });

  it("parses class with extends clause containing nested braces", () => {
    const content = [
      "export declare class Builder<T extends Record<string, { value: unknown }>> {",
      "  build(): T;",
      "  reset(): void;",
      "}",
    ].join("\n");

    const api = parseExportedApi(content, "/fake/index.d.ts", "/fake");
    expect(api.exports.has("Builder")).toBe(true);
    const members = api.membersByExport.get("Builder");
    expect(members).toBeDefined();
    expect(members!.has("build")).toBe(true);
    expect(members!.has("reset")).toBe(true);
  });

  it("parses multiple declarations after a nested-brace declaration", () => {
    const content = [
      "export declare interface First<T extends { x: number }> {",
      "  foo: string;",
      "}",
      "",
      "export declare interface Second {",
      "  bar: number;",
      "}",
    ].join("\n");

    const api = parseExportedApi(content, "/fake/index.d.ts", "/fake");
    expect(api.exports.has("First")).toBe(true);
    expect(api.exports.has("Second")).toBe(true);
    expect(api.membersByExport.get("First")!.has("foo")).toBe(true);
    expect(api.membersByExport.get("Second")!.has("bar")).toBe(true);
  });

  it("still handles simple interfaces without generics", () => {
    const content = [
      "export declare interface Simple {",
      "  name: string;",
      "  getValue(): number;",
      "}",
    ].join("\n");

    const api = parseExportedApi(content, "/fake/index.d.ts", "/fake");
    expect(api.exports.has("Simple")).toBe(true);
    const members = api.membersByExport.get("Simple");
    expect(members).toBeDefined();
    expect(members!.has("name")).toBe(true);
    expect(members!.has("getValue")).toBe(true);
  });
});
```

**Step 2: Run tests to verify the first two fail**

Run: `npx vitest run tests/package-api-brace-tracking.test.ts`
Expected: First two tests FAIL (nested braces confuse current regex), last two PASS

**Step 3: Replace regex body extraction with brace-tracking**

In `src/analysis/package-api-checker.ts`, replace lines 425-442 (the interface/class regex blocks) with a `findDeclarationBodies` function:

```typescript
/**
 * Find interface/class declarations and extract their bodies using manual
 * brace-tracking. This correctly handles nested braces in generic constraints
 * like `interface Foo<T extends { bar: number }> { ... }`.
 */
function findDeclarationBodies(
  content: string,
  kind: "interface" | "class",
): { name: string; body: string }[] {
  const results: { name: string; body: string }[] = [];

  // Match the declaration start — everything up to but NOT including the opening brace
  const pattern = kind === "interface"
    ? /^(?:export\s+(?:declare\s+)?)?interface\s+(\w+)/gm
    : /^(?:export\s+(?:declare\s+)?)?(?:abstract\s+)?class\s+(\w+)/gm;

  for (const match of content.matchAll(pattern)) {
    const name = match[1];
    // Find the first `{` after the match
    let pos = match.index! + match[0].length;
    let depth = 0;
    let bodyStart = -1;

    while (pos < content.length) {
      const ch = content[pos];
      if (ch === "{") {
        if (depth === 0) {
          bodyStart = pos + 1;
        }
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && bodyStart !== -1) {
          const body = content.slice(bodyStart, pos);
          results.push({ name, body });
          break;
        }
      }
      pos++;
    }
  }

  return results;
}
```

Then replace the two regex blocks (lines 425-442) with:

```typescript
  // 6. Extract class/interface members for member access validation
  for (const { name, body } of findDeclarationBodies(dtsContent, "interface")) {
    if (exports.has(name)) {
      membersByExport.set(name, parseObjectMembers(body));
    }
  }

  for (const { name, body } of findDeclarationBodies(dtsContent, "class")) {
    if (exports.has(name)) {
      membersByExport.set(name, parseClassMembers(body));
    }
  }
```

**Step 4: Run tests**

Run: `npx vitest run tests/package-api-brace-tracking.test.ts`
Expected: All PASS

**Step 5: Run the full package-api test suite to check for regressions**

Run: `npx vitest run tests/package-api-checker.test.ts`
Expected: All existing tests still PASS

**Step 6: Commit**

```bash
git add src/analysis/package-api-checker.ts tests/package-api-brace-tracking.test.ts
git commit -m "fix: replace regex body parsing with brace-tracking in package-api-checker"
```

---

### Task 2: Remove dead type-checker (98% FP, disabled everywhere)

The type-checker has a 98% false positive rate and is disabled in all benchmarks. It adds ~600 lines of code and a dedicated MCP tool (`check_types`) that gives users bad results. The only part that's actually useful is `parseObjectMembers()` and `parseClassMembers()` — those are imported by `package-api-checker.ts`.

**Decision:** Remove the type-checker. Extract the shared member-parsing functions into `package-api-checker.ts` where they belong. Remove `check_types` MCP tool, checker registration, and formatter references.

**Files:**
- Modify: `src/analysis/package-api-checker.ts:4` — move `parseObjectMembers` + `parseClassMembers` + `TypeMember` type into this file (or a new small `src/analysis/member-parser.ts`)
- Delete: `src/analysis/type-checker.ts`
- Delete: `src/analysis/checkers/types.ts`
- Modify: `src/analysis/checkers/index.ts:10` — remove `import "./types.js"`
- Modify: `src/mcp/tool-handlers.ts` — remove `check_types` tool registration (~lines 166-193)
- Modify: `src/analysis/formatter.ts:6` — remove `TypeAnalysis` import and `printTypeAnalysis`
- Modify: `bin/arthur-mcp.ts` — update tool count in comment (14 → 13)
- Modify: `README.md` — remove `check_types` from tools table
- Modify: `CLAUDE.md` — update tool count, remove type-checker references

**Step 1: Move shared functions**

Create `src/analysis/member-parser.ts` with the `TypeMember` type, `parseObjectMembers()`, `parseClassMembers()`, and `parseEnumMembers()` functions copied from `type-checker.ts:7-242`. Also copy the `isKeyword` helper and `KEYWORDS` set.

```typescript
/**
 * Shared member-parsing utilities for extracting properties/methods from
 * TypeScript interface, class, and enum body text.
 *
 * Used by package-api-checker to validate member access on imported types.
 */

export interface TypeMember {
  name: string;
  kind: "property" | "method" | "enum-member";
}

// ... paste parseObjectMembers, parseClassMembers, parseEnumMembers, isKeyword, KEYWORDS
// exactly as they are in type-checker.ts lines 168-254
```

**Step 2: Update package-api-checker imports**

In `src/analysis/package-api-checker.ts:4`, change:
```typescript
// Before:
import { parseObjectMembers, parseClassMembers, type TypeMember } from "./type-checker.js";
// After:
import { parseObjectMembers, parseClassMembers, type TypeMember } from "./member-parser.js";
```

**Step 3: Remove type-checker registration and MCP tool**

Remove `import "./types.js"` from `src/analysis/checkers/index.ts`.

Remove the entire `check_types` tool registration block from `src/mcp/tool-handlers.ts` (the `// --- check_types ---` section, ~lines 166-193).

**Step 4: Remove type-checker references from formatter**

In `src/analysis/formatter.ts`, remove the `TypeAnalysis` import and the `printTypeAnalysis` function.

**Step 5: Update documentation**

In `bin/arthur-mcp.ts` header comment: change "15" tools to "14" (or whatever the correct count is after removal). Remove the `check_types` line.

In `README.md`: remove `check_types` row from the tools table. Update "Fourteen tools" references.

In `CLAUDE.md`: update tool count, remove type-checker mentions, remove the gotcha about "Type checker disabled in benchmark — 98% FP rate".

**Step 6: Run all tests to verify nothing breaks**

Run: `npx vitest run`
Expected: All tests PASS. Any test that imports from `type-checker.js` directly will need updating — check `bench/harness/ground-truth.ts:14` which imports `TypeAnalysis`. If benchmark code references `TypeAnalysis`, either remove those references or make them optional.

**Step 7: Verify build**

Run: `npm run build`
Expected: Clean build with no errors

**Step 8: Commit**

```bash
git add -A
git commit -m "refactor: remove type-checker (98% FP rate, disabled everywhere)

Extract shared parseObjectMembers/parseClassMembers into member-parser.ts.
Remove check_types MCP tool, checker registration, and all references."
```

---

### Task 3: Rewrite benchmark narrative to be honest

The README has three structural honesty problems:
1. "Arthur 100%" column is tautological (Arthur defines its own ground truth)
2. Tier 4 headline (79pp gap) buries the fact that 26/48 package API errors are false positives (React re-exports)
3. Tier 4 comparison is apples-to-oranges: Arthur gets full filesystem, self-review gets only CLAUDE.md

The Big Benchmark (equal context) is the fairer comparison but is presented second, below the fold.

**Files:**
- Modify: `README.md`
- Modify: `bench/METHODOLOGY.md`

**Step 1: Rewrite the Tier 4 section**

Replace the current Tier 4 table and surrounding text. The new framing:

```markdown
## Benchmark: Arthur vs Self-Review on a Real Production Project

We tested Arthur against Opus 4.6 self-review on [counselor-sophie](https://github.com/ZachDeLong/counselor-sophie), a production Next.js app with 33 Supabase tables, 17 API routes, and 499 npm packages.

**Important context for interpreting these results:**
- Arthur defines what counts as an "error" using its own checkers. These numbers measure whether self-review agrees with Arthur's classification, not whether the errors are independently verified as real problems.
- In Tier 4, Arthur has full filesystem access while self-review only gets the project's CLAUDE.md. This tests the realistic scenario (self-review works with what it has), but the gap is partly explained by information availability. See the [Big Benchmark](#big-benchmark-static-analysis-vs-self-review-equal-context) for a fairer comparison where both get equal context.
- Package API errors include a known 54% false positive rate on React re-exports (see below).
- All results are from a single run of a non-deterministic process. One task's detection rate varied from 6% to 52% between runs.

**Setup:** 8 feature tasks. Opus generates implementation plans with only the project's CLAUDE.md as context (no file tree, no source code). Then Arthur's checkers and self-review each try to find errors. Self-review gets the same limited context as plan generation.

### Results (single run, Tier 4)

| Category | Errors (Arthur-defined) | Self-Review Caught | Self-Review Missed |
|---|---|---|---|
| File paths | 20 | 5 (25%) | 15 |
| Supabase schema | 44 | 14 (32%) | 30 |
| Package APIs | 22 genuine + 26 React FPs | 3 (6%) | 45 |
| Env vars | 2 | 2 (100%) | 0 |
| **Overall** | **88 genuine + 26 FPs** | **24 (21%)** | **90** |

26 of the 48 package API "errors" are React hooks and types (`useState`, `useEffect`, `React.memo`) that Arthur flags because they aren't direct exports of the `react` package's main entry point, but they work fine at runtime via re-exports. If you exclude these false positives: **88 errors, 64 missed by self-review, 73pp gap.** We report both numbers for transparency.
```

**Step 2: Rewrite the Big Benchmark section**

Rename "Big Benchmark" to emphasize it's the equal-context comparison:

```markdown
## Big Benchmark: Static Analysis vs Self-Review (Equal Context)

A separate benchmark where self-review gets the **full project tree, all schema files, and a maximally adversarial prompt**. This removes the information asymmetry from Tier 4 — both Arthur and self-review have equal access to ground truth files.

11 prompts across 4 fixture projects (TypeScript, Go, Next.js+Prisma, Drizzle+SQL). Model: Opus 4.6.

| Category | Errors (Arthur-defined) | Self-Review Detection Rate |
|---|---|---|
| Path | 30 | 63% |
| Schema (Prisma) | 19 | **100%** |
| SQL Schema (Drizzle) | 15 | **0%** |
| Import | 22 | 77% |
| Env | 7 | **100%** |
| **Total** | **93** | **60%** |

Key finding: **when self-review has full context, the gap narrows significantly.** Prisma schema and env vars reach 100% detection. SQL/Drizzle schema remains a complete blind spot (0%). The remaining 40% gap is concentrated in categories where the error patterns are less obvious to spot by reading (file paths, SQL column names).

Arthur's checkers define the ground truth here — see [bench/METHODOLOGY.md](bench/METHODOLOGY.md) for what that means for precision claims. These are single-run results.
```

**Step 3: Update METHODOLOGY.md**

Add a new section at the top:

```markdown
## Key Methodological Limitation

Arthur's benchmarks use Arthur's own checkers as ground truth. This means:
- Arthur always scores 100% detection by definition — it found the errors because it defined them
- Self-review is scored against Arthur's classification, not independent verification
- Precision (are Arthur's "errors" actually real problems?) is not measured in any benchmark
- The only way to verify precision is human review of individual findings

The benchmarks measure: "given what Arthur classifies as errors, how many does self-review also find?" They do NOT measure: "how many real errors does Arthur find?" Those are different questions.
```

**Step 4: Commit**

```bash
git add README.md bench/METHODOLOGY.md
git commit -m "docs: rewrite benchmark narrative for honesty

- Remove tautological 'Arthur 100%' framing
- Separate genuine errors from React FP count in Tier 4 table
- Lead with methodological caveats, not headline numbers
- Rename Big Benchmark section to emphasize equal context
- Add key limitation section to METHODOLOGY.md"
```

---

### Task 4: Escape variable names in express-route-checker regex construction

`express-route-checker.ts:116` constructs a regex using a variable name directly without escaping:
```typescript
new RegExp(`import\\s+(?:\\{[^}]*\\}|${routerVar})\\s+from\\s+['"\`]([^'"\`]+)['"\`]`)
```
If `routerVar` contains regex special characters (unlikely but possible from bad parsing), this breaks.

**Files:**
- Modify: `src/analysis/express-route-checker.ts:114-127`
- Create: `tests/express-route-escape.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";

describe("express-route-checker regex safety", () => {
  it("escapeRegExp escapes all special characters", async () => {
    const { escapeRegExp } = await import("../src/analysis/express-route-checker.js");
    const input = "foo.bar+baz(qux)";
    const escaped = escapeRegExp(input);
    // Should not throw when used in RegExp
    expect(() => new RegExp(escaped)).not.toThrow();
    // Should match the literal string
    expect(new RegExp(escaped).test(input)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/express-route-escape.test.ts`
Expected: FAIL — `escapeRegExp` doesn't exist yet

**Step 3: Add escapeRegExp and use it**

In `src/analysis/express-route-checker.ts`, add:

```typescript
/** Escape special regex characters in a string for use in RegExp constructor. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

Then update `resolveRouterImport` (lines 116 and 123) to use it:

```typescript
const importRegex = new RegExp(`import\\s+(?:\\{[^}]*\\}|${escapeRegExp(routerVar)})\\s+from\\s+['"\`]([^'"\`]+)['"\`]`);
// ...
const requireRegex = new RegExp(`(?:const|let|var)\\s+${escapeRegExp(routerVar)}\\s*=\\s*require\\s*\\(\\s+['"\`]([^'"\`]+)['"\`]`);
```

**Step 4: Run tests**

Run: `npx vitest run tests/express-route-escape.test.ts && npx vitest run tests/express-route-checker.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/analysis/express-route-checker.ts tests/express-route-escape.test.ts
git commit -m "fix: escape variable names in express-route-checker regex construction"
```

---

## Phase 2: Correctness & Security

### Task 5: Add false positive regression tests

The test suite tests mechanics (does the checker find things?) but never tests precision (does the checker avoid flagging valid code?). Each checker needs at least one test proving valid references produce zero hallucinations.

**Files:**
- Create: `tests/false-positives.test.ts`

**Step 1: Read fixture contents to find real, valid references**

Before writing tests, read the actual fixture files to know what references are valid:
- `bench/fixtures/fixture-a/` — check what files exist, what's in package.json
- `bench/fixtures/fixture-c/` — check Prisma schema for real model/field names
- `bench/fixtures/fixture-d/` — check Drizzle schema for real table/column names
- `bench/fixtures/fixture-e/` — check routes, package.json
- `bench/fixtures/fixture-f/` — check node_modules/zod for real exports

**Step 2: Write the test file**

```typescript
import { describe, it, expect } from "vitest";
import path from "node:path";
import { analyzePackageApi } from "../src/analysis/package-api-checker.js";

// Import registry and checkers
import { getChecker } from "../src/analysis/registry.js";
import "../src/analysis/checkers/index.js";

const FIXTURE_A = path.resolve(__dirname, "../bench/fixtures/fixture-a");
const FIXTURE_C = path.resolve(__dirname, "../bench/fixtures/fixture-c");
const FIXTURE_D = path.resolve(__dirname, "../bench/fixtures/fixture-d");
const FIXTURE_E = path.resolve(__dirname, "../bench/fixtures/fixture-e");
const FIXTURE_F = path.resolve(__dirname, "../bench/fixtures/fixture-f");

describe("False positive regression — valid refs must not be flagged", () => {
  it("paths: existing files produce zero hallucinations", () => {
    // Use files that actually exist in fixture-a (check via fixture contents)
    const checker = getChecker("paths")!;
    const plan = `
## Plan
Modify \`src/index.ts\` to add logging.
Update \`package.json\` with new dependency.
`;
    const result = checker.run({ mode: "plan", text: plan }, FIXTURE_A);
    expect(result.checked).toBeGreaterThan(0);
    expect(result.hallucinated).toBe(0);
  });

  it("schema: real Prisma models/fields produce zero hallucinations", () => {
    // fixture-c has models: participant, contentItem, participantEngagement
    // participant has field: displayIdentifier
    const checker = getChecker("schema")!;
    const plan = `
## Changes
Query the participant model to get displayIdentifier.
Also update contentItem records.
`;
    const result = checker.run({ mode: "plan", text: plan }, FIXTURE_C);
    if (result.applicable) {
      expect(result.hallucinated).toBe(0);
    }
  });

  it("imports: installed packages produce zero hallucinations", () => {
    const checker = getChecker("imports")!;
    const plan = `
\`\`\`typescript
import express from "express";
\`\`\`
`;
    const result = checker.run({ mode: "plan", text: plan }, FIXTURE_E);
    if (result.applicable) {
      expect(result.hallucinated).toBe(0);
    }
  });

  it("package-api: real zod exports produce zero hallucinations", () => {
    const plan = `
\`\`\`typescript
import * as z from 'zod';
const schema = z.object({ name: z.string() });
\`\`\`
`;
    const analysis = analyzePackageApi(plan, FIXTURE_F);
    if (analysis.applicable) {
      const memberHallucinations = analysis.hallucinations.filter(
        h => h.category === "hallucinated-member",
      );
      expect(memberHallucinations).toHaveLength(0);
    }
  });

  it("env: existing env vars produce zero hallucinations", () => {
    const checker = getChecker("env")!;
    // Need to check what .env vars exist in fixture-a
    const plan = `Check that process.env.DATABASE_URL is set.`;
    const result = checker.run({ mode: "plan", text: plan }, FIXTURE_A);
    if (result.applicable) {
      expect(result.hallucinated).toBe(0);
    }
  });
});
```

Note: The exact plan text and model/field names **must** be verified against actual fixture contents at implementation time. Read each fixture's files first. The pattern is: use references that genuinely exist and assert `hallucinated === 0`.

**Step 3: Run tests**

Run: `npx vitest run tests/false-positives.test.ts`
Expected: All PASS

**Step 4: Commit**

```bash
git add tests/false-positives.test.ts
git commit -m "test: add false positive regression tests for all checkers"
```

---

### Task 6: Migrate checkers to request-scoped cache

`CheckerInput.cache` exists but `import-checker.ts` and `package-api-checker.ts` still use module-level `depsCache`/`apiCache`. Migrate them to actually use the request-scoped cache.

**Files:**
- Modify: `src/analysis/import-checker.ts` (~line 248-274)
- Modify: `src/analysis/package-api-checker.ts` (~line 541-597)
- Modify: `src/analysis/checkers/imports.ts` — pass `input.cache`
- Modify: `src/analysis/checkers/package-api.ts` — pass `input.cache`
- Modify: `tests/cache-invalidation.test.ts`

**Step 1: Update `analyzeImports` signature to accept cache**

In `import-checker.ts`, add `cache` parameter to `analyzeImports`:

```typescript
export function analyzeImports(
  text: string,
  projectDir: string,
  cache?: Map<string, unknown>,
): ImportAnalysis {
```

Thread it to `isListedDependency`:

```typescript
function isListedDependency(
  packageName: string,
  projectDir: string,
  cache?: Map<string, unknown>,
): boolean {
  const cacheKey = `deps:${projectDir}`;
  let allDeps = (cache?.get(cacheKey) as Set<string> | undefined) ?? depsCache.get(projectDir);
  if (!allDeps) {
    allDeps = new Set<string>();
    // ... existing parse logic unchanged ...
    depsCache.set(projectDir, allDeps);
    if (cache) cache.set(cacheKey, allDeps);
  }
  return allDeps.has(packageName);
}
```

**Step 2: Update `analyzePackageApi` the same way**

Add `cache` parameter, thread to the API cache lookup at ~line 585:

```typescript
export function analyzePackageApi(
  planText: string,
  projectDir: string,
  cache?: Map<string, unknown>,
): PackageApiAnalysis {
```

In the cache lookup:
```typescript
const cacheKey = `api:${entrypoint}`;
let api = (cache?.get(cacheKey) as PackageApi | undefined) ?? apiCache.get(entrypoint);
if (!api) {
  // ... existing parse logic ...
  apiCache.set(entrypoint, api);
  if (cache) cache.set(cacheKey, api);
}
```

**Step 3: Update checker registrations**

In `src/analysis/checkers/imports.ts`:
```typescript
const analysis = analyzeImports(input.text, projectDir, input.cache);
```

In `src/analysis/checkers/package-api.ts`:
```typescript
const analysis = analyzePackageApi(input.text, projectDir, input.cache);
```

**Step 4: Add test**

In `tests/cache-invalidation.test.ts`:
```typescript
it("request-scoped cache is populated by analyzeImports", () => {
  const cache = new Map<string, unknown>();
  analyzeImports(
    "```ts\nimport express from 'express';\n```",
    path.resolve(__dirname, "../bench/fixtures/fixture-e"),
    cache,
  );
  const hasEntry = [...cache.keys()].some(k => k.startsWith("deps:"));
  expect(hasEntry).toBe(true);
});
```

**Step 5: Run tests**

Run: `npx vitest run tests/cache-invalidation.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/analysis/import-checker.ts src/analysis/package-api-checker.ts src/analysis/checkers/imports.ts src/analysis/checkers/package-api.ts tests/cache-invalidation.test.ts
git commit -m "fix: migrate import and package-api checkers to request-scoped cache"
```

---

### Task 7: Add error logging to MCP catch blocks

All 17 catch blocks in `tool-handlers.ts` silently swallow errors. Add `console.error` logging. Do NOT change the return behavior (MCP clients need the error response).

**Files:**
- Modify: `src/mcp/tool-handlers.ts`

**Step 1: Add `console.error` to each catch block**

Find every catch block and add logging before the return. Each should include the tool name:

```typescript
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[arthur-mcp] Error in check_paths: ${msg}`);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}
```

Do this for all 17 catch blocks. The tool name comes from the surrounding `server.tool("tool_name", ...)` call.

**Step 2: Verify no console.log was added**

Run: `grep -c "console.log" src/mcp/tool-handlers.ts`
Expected: 0 (stdout is JSON-RPC protocol)

**Step 3: Commit**

```bash
git add src/mcp/tool-handlers.ts
git commit -m "fix: log errors to stderr in MCP tool catch blocks"
```

---

### Task 8: Validate git diff ref input

`resolveDiffFiles` passes `diffRef` directly to `execFileSync("git", ["diff", ..., diffRef])`. A crafted ref starting with `--` could be interpreted as a git flag (e.g., `--output=/tmp/evil`).

**Files:**
- Modify: `src/diff/resolver.ts`
- Modify: `tests/diff-resolver.test.ts`

**Step 1: Write failing test**

```typescript
it("rejects refs that look like flags", () => {
  expect(() => resolveDiffFiles(".", "--output=/tmp/evil")).toThrow(/invalid git ref/i);
});

it("rejects refs with shell metacharacters", () => {
  expect(() => resolveDiffFiles(".", "HEAD; rm -rf /")).toThrow(/invalid git ref/i);
});

it("accepts normal refs", () => {
  // These should not throw validation errors (may fail at git level, that's fine)
  expect(() => resolveDiffFiles(".", "HEAD")).not.toThrow(/invalid git ref/i);
  expect(() => resolveDiffFiles(".", "origin/main")).not.toThrow(/invalid git ref/i);
  expect(() => resolveDiffFiles(".", "abc1234")).not.toThrow(/invalid git ref/i);
  expect(() => resolveDiffFiles(".", "HEAD~3")).not.toThrow(/invalid git ref/i);
  expect(() => resolveDiffFiles(".", "v1.0.0")).not.toThrow(/invalid git ref/i);
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/diff-resolver.test.ts`
Expected: FAIL on the flag/metachar tests

**Step 3: Add validation**

At the top of `resolveDiffFiles`, before building args:

```typescript
// Reject flag injection (starts with -) and shell metacharacters
if (/^-/.test(diffRef) || /[;&|`$(){}\[\]!<>\\]/.test(diffRef) || diffRef.length > 256) {
  throw new Error(`Invalid git ref: "${diffRef}"`);
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/diff-resolver.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/diff/resolver.ts tests/diff-resolver.test.ts
git commit -m "fix: validate git diff ref to prevent flag injection"
```

---

### Task 9: Add stdin size limit

`check.ts:51` reads stdin with unbounded `data += chunk`.

**Files:**
- Modify: `src/commands/check.ts:47-54`

**Step 1: Add size limit**

```typescript
export const MAX_STDIN_BYTES = 10 * 1024 * 1024; // 10MB

// Replace the existing stdin reader:
if (opts.stdin || !process.stdin.isTTY) {
  return new Promise((resolve) => {
    let data = "";
    let bytes = 0;
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk as string, "utf-8");
      if (bytes > MAX_STDIN_BYTES) {
        process.stdin.destroy();
        console.error(chalk.red(`Error: stdin input exceeds ${MAX_STDIN_BYTES / 1024 / 1024}MB limit`));
        resolve(null);
        return;
      }
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}
```

**Step 2: Commit**

```bash
git add src/commands/check.ts
git commit -m "fix: add 10MB stdin size limit to prevent OOM"
```

---

## Summary

| Task | Phase | What it fixes |
|---|---|---|
| 1. Brace-tracking in package-api-checker | P1 | Broken regex can't parse nested generics |
| 2. Remove type-checker | P1 | 98% FP dead code adding complexity |
| 3. Rewrite benchmark narrative | P1 | Tautological claims, hidden FPs, context asymmetry |
| 4. Escape regex in express-route-checker | P1 | Regex construction with unescaped user input |
| 5. False positive regression tests | P2 | Zero precision tests in entire test suite |
| 6. Request-scoped cache migration | P2 | Checkers ignore CheckerInput.cache field |
| 7. MCP error logging | P2 | 17 catch blocks silently swallow errors |
| 8. Git ref validation | P2 | Flag injection via crafted diffRef |
| 9. Stdin size limit | P2 | Unbounded stdin reading |
