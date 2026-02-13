# Arthur

Independent verification layer for AI-generated coding plans. Catches hallucinated file paths, schema references, and flawed assumptions before code gets written — using deterministic static analysis where LLMs are unreliable.

## The Problem

AI coding assistants hallucinate. They reference files that don't exist, use wrong model names, and build plans on flawed assumptions. Having the right context doesn't help — models "see" a Prisma schema but still generate `prisma.engagement` instead of `prisma.participantEngagement` because they pattern-match from the task description, not the schema.

The model that generated the plan can't reliably catch its own mistakes. In benchmarks, an LLM verifier with the full project tree in context detected only **33% of hallucinated file paths** — and the rate varied wildly between runs (0% to 67%). A simple file existence check catches 100%, every time.

## The Approach

Arthur combines two verification channels:

1. **Static analysis** — Deterministic checks against ground truth. Parse the real Prisma schema, walk the real file tree, validate every reference mechanically. Zero LLM involvement, zero variance, zero cost.

2. **LLM verifier** — A separate Claude instance reviews the plan as a fresh pair of eyes with project context. Catches the fuzzy stuff static analysis can't: intent drift, wrong abstractions, missing requirements, architectural issues.

Static analysis findings are injected into the LLM verifier's context, so it can confirm and elaborate on what the deterministic checks already found.

**Why plans, not code?** Linters and type-checkers validate written code — they run *after* implementation. By the time `tsc` catches a hallucinated import, the AI has written 200 lines that depend on it. Arthur catches it at the plan stage, when the fix is "change the model name" not "rewrite the feature."

## How It Works

```bash
# Full verification with schema checking
codeverifier verify --plan plan.md --project ./my-app --schema prisma/schema.prisma

# Pure LLM mode (skip static analysis)
codeverifier verify --no-static --plan plan.md --project ./my-app
```

1. Arthur loads the plan and builds a project context snapshot (directory tree, README, CLAUDE.md, referenced source files)
2. Static analysis runs first: validates file paths against the real tree, validates schema references against the real Prisma schema
3. Results print immediately — you see hallucinations before the LLM even starts
4. An independent Claude instance reviews the plan with both the project context and the static findings
5. You get back structured feedback: what's wrong, what's missing, what doesn't exist

## Benchmark Results

### Schema Hallucination (Opus 4.6)

**Fixture:** Next.js + Prisma project with non-obvious naming (`Participant` not `User`, `displayIdentifier` not `username`, `participantEngagement` not `engagement`). Plans generated with README-only context — no schema file provided.

| Prompt | Task | Schema Refs | Hallucinated | Rate | Static Detection | LLM Detection |
|--------|------|------------|-------------|------|-----------------|---------------|
| 06 | Analytics dashboard | 11 | 3 | 27.3% | 3/3 (100%) | 3/3 (100%) |
| 07 | Recommendation engine | 18 | 4 | 22.2% | 4/4 (100%) | 3/4 (75%) |
| 08 | CSV export | 7 | 1 | 14.3% | 1/1 (100%) | 1/1 (100%) |
| **Avg** | | **12** | **2.7** | **21.3%** | **100%** | **91.7%** |

Recurring hallucination: `prisma.engagement` (should be `prisma.participantEngagement`) appeared in **all 3 runs** — systematic bias, not random noise.

### Path Hallucination (Opus 4.6)

| Prompt | Extracted | Hallucinated | Rate | Static Detection | LLM Detection |
|--------|-----------|-------------|------|-----------------|---------------|
| 06 | 7 | 3 | 75% | 3/3 (100%) | 0/3 (0%) |
| 07 | 4 | 3 | 75% | 3/3 (100%) | 2/3 (66.7%) |
| 08 | 5 | 3 | 75% | 3/3 (100%) | 1/3 (33.3%) |
| **Avg** | **5.3** | **3** | **75%** | **100%** | **33.3%** |

The LLM had the full file tree in context and still missed 2/3 of hallucinated paths. Static analysis: 100%, zero variance.

### Intent Drift Detection (Sonnet 4.5)

10 drift specs across 5 prompts, 6 drift categories. Known drift injected into generated plans.

**Overall detection rate: 90% (9/10 injected drifts detected)**

| Category | Detection Rate |
|----------|---------------|
| scope-creep | 80% (4/5) |
| feature-drift | 100% (1/1) |
| wrong-abstraction | 100% (1/1) |
| missing-requirement | 100% (1/1) |
| tech-mismatch | 100% (1/1) |
| wrong-problem | 100% (1/1) |

## Architecture

```
src/
  analysis/     Static analysis (path checker, schema checker, formatter)
  commands/     CLI commands (verify, init)
  config/       Config management (global + project + env)
  context/      Project context builder (tree, file reader, token budget)
  plan/         Plan loading (file, stdin, interactive)
  session/      Session feedback storage (iterative re-verification)
  verifier/     Prompt construction, API streaming, output rendering

bench/
  fixtures/     Test projects (fixture-a: TS, fixture-b: Go, fixture-c: Next.js+Prisma)
  harness/      Benchmark runner, scoring, detection parsing, schema checking
  prompts/      Benchmark prompts + drift specs
  naive-prompt.ts   Frozen baseline prompt (DO NOT MODIFY)
```

## Setup

```bash
npm install
npm run build
codeverifier init  # Set API key

# Run benchmarks
npm run bench:tier1 06    # Schema hallucination (fixture-c)
npm run bench:tier2       # Intent drift detection
```
