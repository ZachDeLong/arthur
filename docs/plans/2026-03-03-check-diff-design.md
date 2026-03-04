# check --diff: Source Code Verification

**Date:** 2026-03-03
**Status:** Approved
**Scope:** Import checker only (first source-mode checker)

## Problem

Arthur currently validates AI-generated *plans* against project ground truth. But plans are upstream of the actual code — errors can still be introduced during implementation. `check --diff` validates the actual code changes, catching hallucinated imports (and eventually other issues) in written source files.

## Approach: Source Adapter Per Checker

Each checker gets an optional source mode via a `CheckerInput` abstraction. Checkers that support source mode process real file contents; those that don't return "source mode not implemented." The import checker is first because its extraction regex already works identically on real source code.

## Design

### 1. Git Diff Plumbing (`src/diff/resolver.ts`)

New module responsible for extracting changed files from git:

- `resolveDiffFiles(projectDir, diffRef, options)` — runs `git diff --name-only --diff-filter=ACMR <ref>`
- `diffRef`: `HEAD` (unstaged), `--staged`, `HEAD~3`, `origin/main`
- Filters to relevant extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`
- Returns `DiffFile[]` — `{ path: string, content: string }`
- Handles errors: not a git repo, invalid ref, deleted files

### 2. Input Mode Abstraction (`src/analysis/registry.ts`)

Extended `CheckerDefinition` interface:

```typescript
interface CheckerInput {
  mode: "plan" | "source";
  text: string;
  files?: DiffFile[];
}

interface CheckerDefinition {
  // ... existing fields ...
  supportsSourceMode?: boolean;
  run(input: CheckerInput, projectDir: string, options?: Record<string, string>): CheckerResult;
}
```

- Checkers without source support return `{ applicable: false, notApplicableReason: "source mode not implemented" }`
- `runAllCheckers()` gains optional `inputMode` parameter

### 3. Import Checker Source Adapter

- `analyzeImports()` gains optional `mode` parameter
- Source mode processes each `DiffFile` individually for per-file attribution
- `ImportRef` gets optional `file?: string` field
- `shouldSkip()` unchanged — same filtering in both modes
- Extraction regex works identically on real source (no backtick noise)

### 4. CLI Integration (`src/commands/check.ts`)

New flags on `arthur check`:

```
arthur check --diff HEAD --project .              # all uncommitted changes
arthur check --diff --staged --project .          # staged only (pre-commit)
arthur check --diff origin/main --project .       # CI: branch point
arthur check --diff HEAD --strict --format json . # experimental + JSON
```

- `--diff` and `--plan` are mutually exclusive
- Output format identical: same text table, same JSON report
- Exit codes unchanged: 0 = clean, 1 = findings

### 5. MCP Server (`bin/arthur-mcp.ts`)

New `check_diff` tool:

- Parameters: `project_directory`, `diff_ref` (default HEAD), `staged` (boolean), `strict`, `include_experimental`
- Returns same markdown format as `check_all`
- Logged to `.arthur/catches.jsonl`
- Parallel to `check_all` — plan input vs source input

### 6. Out of Scope

- Other checkers in source mode (paths, schema, env, routes) — future PRs
- Git hooks (`arthur hooks install`) — Phase 2
- Changes to `verify_plan` — stays plan-only
- Per-file line numbers in findings — future enhancement

### 7. Testing

- Unit tests for `resolveDiffFiles()` — mock git, extension filtering, errors
- Unit tests for import checker source mode — per-file attribution, validation
- Integration test for `arthur check --diff` — end-to-end with test git repo
