# Arthur

Adversarial code reviewer for AI-generated plans and code. Arthur catches errors that self-review misses — hallucinated paths, wrong schema references, intent drift — even when the primary LLM has fresh context. It's code review, not memory management.

## Core Value Prop

Arthur isn't competing with "clear context." Even with a fresh context, an LLM that wrote a plan can faithfully execute a bad plan. Arthur reads adversarially — a second pair of eyes that catches blind spots the author can't see.

## Architecture

```
bin/
  codeverifier.ts   CLI entry point
  arthur-mcp.ts     MCP server (stdio transport, 8 tools)

src/
  analysis/     Static analysis (path-checker, schema-checker, sql-schema-checker, import-checker, env-checker, type-checker, api-route-checker, formatter)
  commands/     CLI commands (verify, init)
  config/       Config management (global + project + env)
  context/      Project context builder (tree, file reader, token budget)
  plan/         Plan loading (file, stdin, interactive)
  session/      Session feedback storage (iterative re-verification)
  verifier/     Prompt construction, API streaming, output rendering

bench/
  fixtures/     Test projects with known structures (fixture-a: TS, fixture-b: Go, fixture-c: Next.js+Prisma, fixture-d: Drizzle+SQL)
  harness/      Benchmark runner, scoring, detection parsing, schema checking
    report-generator.ts   Publishable markdown report from results
    self-review-runner.ts Self-review vs Arthur comparison harness
  prompts/      Benchmark prompts + drift specs
    self-review-prompt.ts Fair adversarial self-review prompt
  naive-prompt.ts   Frozen baseline prompt (DO NOT MODIFY)
  tier3/
    prompt.md         Refactoring prompt for both arms
    scripts/          setup, verify-plan, evaluate, compare
    workspaces/       Gitignored — created by setup at ~/.arthur-tier3-workspaces/
    results/          Gitignored — per-run timestamped results
```

## MCP Server

Eight tools, two tiers:
- `check_paths` — deterministic path validation against project tree (no API key)
- `check_schema` — deterministic Prisma schema validation (no API key)
- `check_imports` — deterministic package import validation against node_modules (no API key)
- `check_env` — deterministic env variable validation against .env* files (no API key)
- `check_types` — deterministic TypeScript type validation against project .ts/.tsx files (no API key)
- `check_routes` — deterministic Next.js App Router API route validation (no API key)
- `check_sql_schema` — deterministic Drizzle/SQL schema validation against pgTable/mysqlTable/sqliteTable + CREATE TABLE (no API key)
- `verify_plan` — full pipeline: static analysis + LLM adversarial review (requires ANTHROPIC_API_KEY)

**Add to Claude Code:** `claude mcp add arthur -- node /path/to/arthur/dist/bin/arthur-mcp.js`

**Critical:** No `console.log()` in `arthur-mcp.ts` — stdout is JSON-RPC protocol. Use `console.error()` for debug output.

## Build & Run

- `npm run build` — compile TypeScript (also verifies types)
- `npm run dev` — run CLI via tsx
- `npm run mcp` — run MCP server via tsx (for development)
- `npm run bench` or `npm run bench:tier1` — run Tier 1 (hallucination detection)
- `npm run bench:tier2` — run Tier 2 (intent drift detection)
- `npm run bench:report` — generate publishable markdown report from existing results
- `npm run bench:self-review` — run self-review vs Arthur comparison benchmark
- `npm run bench:self-review -- 06 07 08` — run self-review on specific prompts
- `npm run bench:big` — run big benchmark (all 7 checkers vs self-review, all prompts)
- `npm run bench:big -- 06 09` — run big benchmark on specific prompts
- `npm run bench:big:report` — regenerate report from latest big benchmark results
- `npm run bench:tier3:setup` — clone target repo into workspaces
- `npm run bench:tier3:verify -- <plan> <workspace>` — run Arthur verifier on a plan
- `npm run bench:tier3:eval -- <arm> <workspace> <output-dir>` — evaluate post-refactoring
- `npm run bench:tier3:compare -- <results-dir>` — side-by-side comparison
- `npm run bench -- tier3` — print the full T3 workflow instructions
- No tsconfig path aliases — use relative imports

## Key Conventions

- **Naive prompt is frozen** — `bench/naive-prompt.ts` must never be modified. It's the reproducible baseline.
- **Results dir is gitignored** — benchmark results in `bench/results/` are local only.
- **Config locations** — global: `~/.codeverifier/config.json`, project: `.codeverifier/config.json`, env: `ANTHROPIC_API_KEY`
- **Token budget** — default 80k. Priority order: prompt > plan > README > CLAUDE.md > session feedback > referenced files > tree.
- **Model default** — `claude-sonnet-4-5-20250929` (Sonnet 4.5). Override via project config `.codeverifier/config.json` (currently set to `claude-opus-4-6`).
- **Fixture src/ excluded from root tsconfig** — `bench/fixtures/*/src` is excluded because fixture source files have their own deps (Next.js, Prisma, etc.).

## Benchmark System

### Tier 1: Hallucination Detection
Generates plans with README-only context, then verifies against full project tree. Two detection channels:

**Path hallucination**: Catches file paths that don't exist. Detection via 4-tier parsing: direct match → sentiment → section → directory correction.

**Schema hallucination** (prompts 06-08, fixture-c): Catches hallucinated Prisma models, fields, methods, and relations against a real `schema.prisma`. Fixture-c uses non-obvious naming (Participant not User, displayIdentifier not username, etc.) to tempt hallucinations. Schema checker at `bench/harness/schema-checker.ts` parses schema and classifies plan references.

### Tier 2: Intent Drift Detection
Injects synthetic drift into generated plans (scope creep, feature drift, wrong abstraction, missing requirement, wrong problem, tech mismatch). Measures whether the verifier catches the drift. Detection via 3-tier scoring: critical-callout → alignment-section → signal-match.

- **Sonnet 4.5 baseline**: ~90% Tier 2 detection rate
- **Drift specs**: `bench/prompts/drift-specs.json` — each spec applied independently (one injection per verification run)
- **Replace-based specs are fragile** — regex patterns must account for non-deterministic LLM output. `append` is always reliable.

### Self-Review vs Arthur Benchmark
Directly compares self-review (same LLM checks its own plan) vs Arthur (fresh instance). Both arms get identical context and a maximally adversarial prompt. Ground truth from static checkers.

- **Self-review prompt**: `bench/prompts/self-review-prompt.ts` — mirrors Arthur's adversarial posture exactly
- **Runner**: `bench/harness/self-review-runner.ts` — generates plan, runs both arms, scores against ground truth
- **Results**: `bench/results/self-review-<timestamp>/` — per-run JSON + comparison report
- **Report generation**: `bench/harness/report-generator.ts` — aggregates all results into publishable markdown

### Big Benchmark: Static Analysis vs Self-Review
Measures what self-review misses. Static checkers run against LLM-generated plans to identify verifiable structural errors. Self-review (same model, adversarial prompt, full context) tries to independently find the same errors.

- **Runner**: `bench/harness/big-benchmark-runner.ts` — generates plan, runs checkers, runs self-review, scores
- **Ground truth**: `bench/harness/ground-truth.ts` — converts checker outputs to flat error list
- **Detection**: `bench/harness/unified-detection-parser.ts` — parses self-review output for error detection
- **Prompt**: `bench/prompts/big-benchmark-prompt.ts` — adversarial self-review prompt
- **Report**: `bench/harness/big-benchmark-report.ts` — generates markdown from results
- **Results**: `bench/results/big-<timestamp>/` — per-run JSON + summary + report
- **Ship run (2026-02-14)**: 93 errors, 60% self-review detection, 37 errors missed. 5 categories (type checker disabled — 98% FP rate).
- Run with: `npm run bench:big` or `npm run bench:big -- 06 07 08 09 10 11`

**Type checker disabled in benchmark** — extracted PascalCase words from inline backticks, producing 40 FPs out of 41 flags. Needs structural fix: restrict to fenced code blocks, require syntactic type positions (after `:`, inside `<>`, after `extends`). The MCP tool `check_types` still works for individual use.

**Next benchmark framing fix:** Drop the "100% static" column (tautological). Lead with "37 errors self-review missed despite having full context."

### Tier 3: Real-World Refactoring Verification
Hybrid benchmark — automated setup + manual Claude Code sessions. Two arms (vanilla vs Arthur-assisted) run the same refactoring prompt on a real codebase. Automated scoring: build pass/fail, App.tsx reduction, files extracted, hallucinated imports.

- **Workspaces live at `~/.arthur-tier3-workspaces/`** — NOT inside `~/arthur/` (prevents CLAUDE.md contamination via directory walk)
- **Must commit workspace changes before eval** — `evaluate.ts` uses `git diff HEAD~1`
- **First run (ai-reasoning-hub App.tsx)**: Both arms scored 100/100 — task was too easy for Opus. Need harder targets
- **Single runs are insufficient** — LLM variance between runs exceeds variance between arms. Need 3-5 runs per arm for statistical significance

## Branches

- `master` — stable, overview
- `arthur` — tool development (CLI, verifier, context builder)
- `benchmarks` — benchmark harness, fixtures, drift specs

## Strategic Direction

Arthur's value is **breadth of automatic coverage**, not fresh eyes or context management. Self-review with an explicit adversarial prompt can match Arthur on any single error category — but no single prompt covers all categories simultaneously. Each static checker runs independently at 100% detection with zero attention budget competition. The more checkers Arthur has, the wider the gap vs any prompting approach. Academic backing: Los Alamos "Trinity Defense Architecture" (arXiv:2602.09947v1) — Theorem 3.3 proves training-based defenses alone cannot provide deterministic guarantees.

**Proven results (T1/T2):**
- Schema hallucination: 91.7% detection rate (100% static). Opus hallucinates `prisma.engagement` every time
- Path hallucination: 100% static detection vs 0-33% LLM detection
- Intent drift: ~90% detection rate (Sonnet 4.5 baseline)

**Big benchmark (2026-02-14, ship numbers):**
- 93 errors across 11 prompts, 4 fixtures (Opus 4.6). Self-review detected 60%. **37 errors missed.**
- Per-category: sql_schema 0%, path 63%, import 77%, schema 100%, env 100%
- Self-review has complete blind spots (0% on SQL schema with full schema in context)
- 2 minor FPs remain (2.2% FP rate). Type checker disabled (98% FP rate).
- Results at: `bench/results/big-2026-02-14T03-03-02/`

**Self-review vs Arthur benchmark (implemented):**
- Both arms get fresh context (no context degradation variable)
- Arm A: LLM generates plan → LLM self-reviews (adversarial prompt, full codebase)
- Arm B: LLM generates plan → Arthur reviews (fresh instance, adversarial posture)
- Measure: detection rate of real errors against ground truth (static checker results)
- Self-review prompt is maximally adversarial — same instructions as Arthur
- Run with: `npm run bench:self-review` or `npm run bench:self-review -- 06 07 08`

**Killed directions:**
- Balatro benchmark: failed call rate 0-3%, Arthur's ceiling too low for signal
- N-step context degradation: "clear context" solves this, Arthur is redundant for memory
- Context regulation: not Arthur's differentiator

## Gotchas

- `.*` in JS regex doesn't cross newlines — use `[^#]*` or `[\s\S]*?` for multi-line section matches
- Plans are non-deterministic — `replace`-based drift injections may fail to match. Record as "skipped", not "missed".
- ACT/SAT-style numeric extractions from LLMs may return decimals — round before storing.
- **No `console.log()` in MCP server** — stdout is JSON-RPC. Use `console.error()`.
- **Benchmark workspaces per-benchmark, not shared** — each benchmark creates its own vanilla/arthur-assisted pair at `~/.arthur-benchmarks/<name>/`
- **Fixtures don't have node_modules** — import checker must fall back to package.json deps, not just node_modules. Already implemented.
- **SQL FROM regex matches comments inside code blocks** — restricting to fenced code blocks isn't enough; comments (`// from the database`) still match. English stopword list handles known cases but isn't exhaustive.
- **Type checker inline backticks = FP factory** — extracting PascalCase words from inline backtick spans catches prose headings and English words. Must restrict to fenced code blocks + syntactic positions only. Currently disabled in benchmark.
- **"100% static detection" framing is tautological** — Arthur defines the ground truth then claims 100%. Seeded fault methodology was tried and doesn't help: injected faults favor self-review (cross-referencing inconsistencies is easy). Lead with "37 errors self-review missed" from the big benchmark instead — organic errors are the real differentiator.
