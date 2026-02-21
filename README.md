# Arthur

Ground truth verification for AI-generated code plans. Catches hallucinated file paths, schema references, imports, env vars, types, and API routes before code gets written. Deterministic, zero cost, no API key.

## The Problem

AI coding assistants hallucinate. They reference files that don't exist, query database columns that aren't real, import packages that aren't installed, and build plans on assumptions that don't match the actual codebase.

The model can't reliably catch its own mistakes. Self-review is limited by the same context constraints and attention budget that caused the hallucinations in the first place.

Arthur runs deterministic checks against ground truth (your actual files, schemas, packages, env vars) and returns the results, including what actually exists, so the model can self-correct.

## Install

```bash
claude mcp add arthur -- npx arthur-mcp
```

Arthur is now available as an MCP server in Claude Code. All tools run locally. No API key, no credits, no config.

## Benchmark: Arthur vs Self-Review on a Real Production Project

We tested Arthur against Opus 4.6 self-review on [counselor-sophie](https://github.com/ZachDeLong/arthur), a production Next.js app with 33 Supabase tables, 17 API routes, and 499 npm packages.

**Setup:** 8 feature tasks (add email notifications, CSV import, counselor dashboard, etc.). For each task, Opus generates an implementation plan with only the project's CLAUDE.md as context (no file tree, no source code). Then Arthur's static checkers and self-review each try to find errors in the plan. Self-review gets the same limited context as plan generation, which is realistic: in Claude Code, the LLM that reviews its own plan doesn't suddenly get more files than when it wrote it.

### Results

| Category | Errors | Arthur | Self-Review | Gap |
|---|---|---|---|---|
| File paths | 20 | 100% | 25% | 75pp |
| Supabase schema | 44 | 100% | 32% | 68pp |
| Package APIs | 48 | 100% | 6% | 94pp |
| Env vars | 2 | 100% | 100% | 0pp |
| **Overall** | **114** | **100%** | **21%** | **79pp** |

Arthur caught 90 errors that self-review missed.

### What the errors look like

**Supabase schema (44 errors, 32% self-review detection):** Opus knows table names from CLAUDE.md but guesses column names wrong. It writes `.select('early_decision_deadline')` when the actual column is something different. It invents tables like `email_log`, `deadline_reminders`, `essay_drafts` that don't exist. Self-review can't verify these without seeing the actual `database.types.ts` file.

**Package APIs (48 errors, 6% self-review detection):** Opus writes `import { NextRequest } from 'next'` (should be `next/server`) in 5 of 8 tasks, and self-review never flags it. It imports from `@react-email/components` (not installed). It references `React.memo` and `React.ChangeEvent` as direct members.

**File paths (20 errors, 25% self-review detection):** Opus invents `components/counselor/CounselorStats.tsx`, `hooks/useCounselorDashboard.ts`, and `supabase/migrations/` paths that don't exist in the project.

### Limitations and confounding variables

We want to be upfront about what these numbers do and don't prove.

**Package API errors are inflated by React re-exports.** 26 of the 48 package_api errors are React hooks and types (`useState`, `useEffect`, `React.memo`, `React.Fragment`) that the checker flags because they aren't direct exports of the `react` package's main entry point, but they work fine at runtime via re-exports. The remaining 22 are genuine failures: 12 wrong Next.js subpath imports (`next` instead of `next/server`) and 10 imports from uninstalled packages (`@react-email/components`). If you exclude the React re-exports, the overall numbers drop to 88 total errors with a 73pp gap. We're reporting both for transparency.

**Single project.** Tier 4 only runs against counselor-sophie. It's a real production codebase, but it's one project. We don't know how these numbers generalize to Python projects, Go backends, or smaller codebases. The [Big Benchmark](#big-benchmark-static-analysis-vs-self-review-full-context) tests across 4 different fixture projects but with a different methodology.

**Self-review is non-deterministic.** LLM output varies between runs. In our first run, Task 04 self-review caught 6% of errors. In the second run with the same cached plan, it caught 52%. The overall gap (79pp) is from a single run. Running multiple trials and averaging would give more robust numbers, but costs money.

**Detection parser has limits.** We determine whether self-review "caught" an error by parsing its output for mentions of the error term near negative sentiment phrases. If self-review flagged an issue using unusual phrasing the parser didn't recognize, we'd score it as a miss. This could undercount self-review's actual performance.

**Arthur has its own false positive rate.** In the Big Benchmark (different methodology, full-context self-review), Arthur's checkers had a 2.2% false positive rate. The React re-exports described above are an example of technically-correct-but-not-useful findings.

**Only tested on Opus 4.6.** We haven't run Tier 4 on Sonnet, Haiku, GPT-4, or other models. The gap could be larger or smaller depending on the model.

**Limited context is a design choice, not a flaw.** We gave self-review the same context as plan generation (CLAUDE.md only) because that's realistic. You could argue self-review should get more context, and the [Big Benchmark](#big-benchmark-static-analysis-vs-self-review-full-context) tests exactly that. Even with the full project tree, self-review still missed 40% of errors.

### Full results

Complete benchmark data including every individual error, detection method, and the generated plans: [`bench/results/`](bench/results/)

## Big Benchmark: Static Analysis vs Self-Review (Full Context)

A separate benchmark where self-review gets the **full project tree, all schema files, and a maximally adversarial prompt**. This is the best-case scenario for self-review: unlimited context with explicit instructions to check every category.

11 prompts across 4 fixture projects (TypeScript, Go, Next.js+Prisma, Drizzle+SQL). Model: Opus 4.6.

| Category | Errors Found | Self-Review Missed | Self-Review Detection Rate |
|---|---|---|---|
| Path | 30 | 11 | 63% |
| Schema (Prisma) | 19 | 0 | 100% |
| SQL Schema (Drizzle) | 15 | 15 | 0% |
| Import | 22 | 5 | 77% |
| Env | 7 | 0 | 100% |
| **Total** | **93** | **37** | **60%** |

Even with full context, self-review missed 37 errors. SQL/Drizzle schema was a complete blind spot (0% detection). Arthur caught all 93 deterministically.

## How It Works

1. Claude Code generates a plan
2. Claude Code calls Arthur's `check_all` tool
3. Arthur validates every reference against ground truth (file tree, schemas, node_modules, .env files, types, routes)
4. Arthur returns findings **with the correct values**: not just "this is wrong" but "this is wrong, here's what actually exists"
5. Claude Code reads the findings and corrects its plan

```
# When Arthur finds a hallucinated Prisma model:
✗ prisma.engagement - hallucinated-model -> prisma.participantEngagement
  Available models: participant (Participant), contentItem (ContentItem),
                    participantEngagement (ParticipantEngagement)

# When Arthur finds a hallucinated file path:
✗ src/models/User.ts - NOT FOUND
  Closest: src/lib/db.ts, src/app/api/participants/route.ts

# When Arthur finds a wrong Supabase column:
✗ .select('...early_decision_deadline...') - hallucinated-column
  Available columns on college_tiers: id, name, tier, acceptance_rate, ...
```

## Recommended Setup

Add this to your project's `CLAUDE.md` so Claude Code uses Arthur automatically:

```markdown
## Verification

Before implementing any plan, call the `check_all` MCP tool with the plan text and project directory.
Fix all hallucinated references using the ground truth provided in the response before writing code.
```

## Tools

### `check_all` (recommended)

Runs all 9 checkers in a single call. Returns a comprehensive report with ground truth context for every finding.

```
check_all(planText, projectDir)
```

### Individual Checkers

| Tool | What it catches | Ground truth source |
|---|---|---|
| `check_paths` | Hallucinated file paths | Project directory tree |
| `check_schema` | Wrong Prisma models, fields, methods, relations | `schema.prisma` |
| `check_sql_schema` | Wrong Drizzle/SQL tables, columns | `pgTable()` / `CREATE TABLE` |
| `check_supabase_schema` | Wrong Supabase tables, columns, functions | `database.types.ts` |
| `check_imports` | Non-existent packages, invalid subpaths | `node_modules` + `package.json` |
| `check_env` | Undefined environment variables | `.env*` files |
| `check_types` | Hallucinated TypeScript types/members | Project `.ts`/`.tsx` files |
| `check_routes` | Non-existent API routes, wrong methods | Next.js App Router `route.ts` files |
| `check_express_routes` | Wrong Express/Fastify routes | Express/Fastify route registrations |

All checkers auto-detect. If a project has no Prisma schema, that checker silently returns nothing.

### `verify_plan` (optional, requires API key)

Full pipeline: all static checks + LLM review by a separate Claude instance. Requires `ANTHROPIC_API_KEY`.

## CLI (alternative to MCP)

```bash
npm install -g arthur-mcp

# Static analysis only (no API key needed)
arthur check --plan plan.md --project ./my-app

# Full verification (static + LLM review)
codeverifier verify --plan plan.md --project ./my-app
```

## Development

```bash
git clone https://github.com/ZachDeLong/arthur.git
cd arthur
npm install
npm run build

# Run MCP server locally
npm run mcp

# Run benchmarks
npm run bench:tier4          # Arthur vs self-review on real project (requires API key)
npm run bench:big            # Static analysis vs self-review (full context, requires API key)
npm run bench:tier4 -- score # Re-score cached plans
npm run bench:tier4 -- report # Regenerate report from existing results
```

## License

MIT
