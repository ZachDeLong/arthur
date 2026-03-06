# Arthur

Ground truth verification for AI-generated code plans. Catches hallucinated file paths, schema references, imports, env vars, types, routes, and package API usage before code gets written. Deterministic, zero cost, no API key.

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

### What the errors look like

**Supabase schema (44 errors, 32% self-review detection):** Opus knows table names from CLAUDE.md but guesses column names wrong. It writes `.select('early_decision_deadline')` when the actual column is something different. It invents tables like `email_log`, `deadline_reminders`, `essay_drafts` that don't exist. Self-review can't verify these without seeing the actual `database.types.ts` file.

**Package APIs (22 genuine errors, 6% self-review detection):** Opus writes `import { NextRequest } from 'next'` (should be `next/server`) in 5 of 8 tasks, and self-review never flags it. It imports from `@react-email/components` (not installed).

**File paths (20 errors, 25% self-review detection):** Opus invents `components/counselor/CounselorStats.tsx`, `hooks/useCounselorDashboard.ts`, and `supabase/migrations/` paths that don't exist in the project.

### Full results

Complete benchmark data including every individual error, detection method, and the generated plans: [`bench/results/`](bench/results/)

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

Runs all stable checkers in a single call (paths, Prisma, SQL/Drizzle, Supabase, imports, env, Next.js routes, Express/Fastify routes). Returns a comprehensive report with ground truth context for every finding.

By default, experimental checkers (`TypeScript Types`, `Package API`) are excluded. Enable them with `includeExperimental: true` or `strict: true`.

```
check_all(planText, projectDir)
```

`check_all` now also reports:
- Which checkers were skipped/not applicable (and why)
- A coverage gate (`minCheckedRefs`) so “all checks passed” is not returned for near-empty plans

### Individual Checkers

| Tool | What it catches | Ground truth source |
|---|---|---|
| `check_paths` | Hallucinated file paths | Project directory tree |
| `check_schema` | Wrong Prisma models, fields, methods, relations | `schema.prisma` |
| `check_sql_schema` | Wrong Drizzle/SQL tables, columns | `pgTable()` / `CREATE TABLE` |
| `check_supabase_schema` | Wrong Supabase tables, columns, functions | `database.types.ts` |
| `check_imports` | Non-existent packages, invalid subpaths | `node_modules` + `package.json` |
| `check_env` | Undefined environment variables | `.env*` files |
| `check_routes` | Non-existent API routes, wrong methods | Next.js App Router `route.ts` files |
| `check_express_routes` | Wrong Express/Fastify routes | Express/Fastify route registrations |
| `check_package_api` *(experimental)* | Hallucinated named imports/member access in package APIs | Package `.d.ts` exports in `node_modules` |

All checkers auto-detect. If a project has no Prisma schema, that checker silently returns nothing.

### `verify_plan` (optional, requires API key)

Full pipeline: all static checks + LLM review by a separate Claude instance. Requires `ANTHROPIC_API_KEY`.
Supports the same checker policy options as `check_all`: `includeExperimental`, `strict`, `minCheckedRefs`, and `coverageMode`.

## CLI (alternative to MCP)

```bash
npm install -g arthur-mcp

# Static analysis only (no API key needed)
arthur check --plan plan.md --project ./my-app
arthur check --plan plan.md --project ./my-app --strict
arthur check --plan plan.md --project ./my-app --include-experimental --min-checked-refs 5 --coverage-mode warn

# Full verification (static + LLM review)
codeverifier verify --plan plan.md --project ./my-app
```

### Per-project defaults

Create `.arthur/config.json` in a repo to set defaults:

```json
{
  "includeExperimental": true,
  "minCheckedRefs": 5,
  "coverageMode": "warn"
}
```

`strict` mode overrides defaults by forcing experimental checkers on and defaulting coverage mode to `fail` (with min refs defaulting to 5 unless set explicitly).

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
