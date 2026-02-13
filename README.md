# Arthur

Independent verification layer for AI-generated coding plans. Catches hallucinated file paths, schema references, imports, env vars, types, API routes, and flawed assumptions before code gets written — using deterministic static analysis where LLMs are unreliable.

## The Problem

AI coding assistants hallucinate. They reference files that don't exist, use wrong model names, import packages that aren't installed, reference env vars that aren't defined, and build plans on flawed assumptions. Having the right context doesn't help — models "see" a Prisma schema but still generate `prisma.engagement` instead of `prisma.participantEngagement` because they pattern-match from the task description, not the schema.

The model that generated the plan can't reliably catch its own mistakes. In benchmarks, an LLM verifier with the full project tree in context detected only **33% of hallucinated file paths** — and the rate varied wildly between runs (0% to 67%). A simple file existence check catches 100%, every time.

## The Approach

Arthur combines two verification channels:

1. **Static analysis** — Deterministic checks against ground truth. Parse the real schemas, walk the real file tree, resolve real package exports, validate every reference mechanically. Zero LLM involvement, zero variance, zero cost.

2. **LLM verifier** — A separate Claude instance reviews the plan as a fresh pair of eyes with project context. Catches the fuzzy stuff static analysis can't: intent drift, wrong abstractions, missing requirements, architectural issues.

Static analysis findings are injected into the LLM verifier's context, so it can confirm and elaborate on what the deterministic checks already found.

**Why plans, not code?** Linters and type-checkers validate written code — they run *after* implementation. By the time `tsc` catches a hallucinated import, the AI has written 200 lines that depend on it. Arthur catches it at the plan stage, when the fix is "change the model name" not "rewrite the feature."

## Static Analysis Checkers

Seven deterministic checkers, each parsing references from AI output and validating against ground truth:

| Checker | What it catches | Ground truth |
|---------|----------------|-------------|
| **Path checker** | Hallucinated file paths | Project directory tree |
| **Prisma schema checker** | Wrong models, fields, methods, relations | `schema.prisma` |
| **SQL/Drizzle schema checker** | Wrong tables, columns | `pgTable()`/`mysqlTable()`/`sqliteTable()` + `CREATE TABLE` |
| **Import checker** | Non-existent packages, invalid subpaths | `node_modules` + package `exports` |
| **Env checker** | Undefined environment variables | `.env*` files |
| **Type checker** | Hallucinated TypeScript types/members | Project `.ts`/`.tsx` files |
| **API route checker** | Non-existent routes, wrong HTTP methods | Next.js App Router `route.ts` files |

All checkers auto-detect — no flags needed. If a project has no Prisma schema or no Drizzle tables, those checkers silently return empty results.

## How It Works

### CLI

```bash
# Full verification (static analysis + LLM review)
codeverifier verify --plan plan.md --project ./my-app

# With Prisma schema checking
codeverifier verify --plan plan.md --project ./my-app --schema prisma/schema.prisma

# Pure LLM mode (skip static analysis)
codeverifier verify --no-static --plan plan.md --project ./my-app
```

### MCP Server (for Claude Code)

```bash
# Add to Claude Code
claude mcp add arthur -- node /path/to/arthur/dist/bin/arthur-mcp.js
```

Eight tools available:

| Tool | API Key | Description |
|------|---------|-------------|
| `check_paths` | No | Validate file paths against project tree |
| `check_schema` | No | Validate Prisma schema references |
| `check_sql_schema` | No | Validate Drizzle/SQL table and column references |
| `check_imports` | No | Validate package imports against node_modules |
| `check_env` | No | Validate env variable references against .env files |
| `check_types` | No | Validate TypeScript type references |
| `check_routes` | No | Validate Next.js API route references |
| `verify_plan` | Yes | Full pipeline: all static checks + LLM review |

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
bin/
  codeverifier.ts   CLI entry point
  arthur-mcp.ts     MCP server (stdio transport, 8 tools)

src/
  analysis/     Static analysis (path, prisma-schema, sql-schema, imports, env, types, api-routes, formatter)
  commands/     CLI commands (verify, init)
  config/       Config management (global + project + env)
  context/      Project context builder (tree, file reader, token budget)
  plan/         Plan loading (file, stdin, interactive)
  session/      Session feedback storage (iterative re-verification)
  verifier/     Prompt construction, API streaming, output rendering

bench/
  fixtures/     Test projects (fixture-a: TS, fixture-b: Go, fixture-c: Next.js+Prisma, fixture-d: Drizzle+SQL)
  harness/      Benchmark runner, scoring, detection parsing, schema checking
  prompts/      Benchmark prompts + drift specs
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
