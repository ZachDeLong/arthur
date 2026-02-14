# Arthur

Ground truth verification for AI-generated code. Catches hallucinated file paths, schema references, imports, env vars, types, and API routes before code gets written — deterministically, zero cost, no API key.

## Install

```bash
claude mcp add arthur -- npx arthur-mcp
```

That's it. Arthur is now available as an MCP server in Claude Code. All tools run locally — no API key, no credits, no config.

## Why

AI coding assistants hallucinate. They reference files that don't exist, use wrong schema names, import packages that aren't installed, and build plans on assumptions that don't match the codebase.

The model can't reliably catch its own mistakes. In benchmarks, self-review with full project context and an adversarial prompt missed **40% of verifiable errors**. A simple file existence check catches 100%, every time.

Arthur runs deterministic checks against ground truth (your actual files, schemas, packages) and returns the results — including what actually exists — so Claude Code can self-correct. No second LLM call needed.

## How It Works

1. Claude Code generates a plan
2. Claude Code calls Arthur's `check_all` tool
3. Arthur validates every reference against ground truth (file tree, schemas, node_modules, .env files, types, routes)
4. Arthur returns findings **with the correct values** — not just "this is wrong" but "this is wrong, here's what actually exists"
5. Claude Code reads the findings and corrects its plan

The LLM reasoning step is free because it's the same Claude Code session you're already paying for.

## Recommended Setup

Add this to your project's `CLAUDE.md` so Claude Code uses Arthur automatically:

```markdown
## Verification

Before implementing any plan, call the `check_all` MCP tool with the plan text and project directory.
Fix all hallucinated references using the ground truth provided in the response before writing code.
```

## Tools

### `check_all` (recommended)

Runs all 7 checkers in a single call. Returns a comprehensive report with ground truth context for every finding. This is the tool Claude Code should call.

```
check_all(planText, projectDir)
```

### Individual Checkers

| Tool | What it catches | Ground truth source |
|------|----------------|-------------------|
| `check_paths` | Hallucinated file paths | Project directory tree |
| `check_schema` | Wrong Prisma models, fields, methods, relations | `schema.prisma` |
| `check_sql_schema` | Wrong Drizzle/SQL tables, columns | `pgTable()` / `CREATE TABLE` |
| `check_imports` | Non-existent packages, invalid subpaths | `node_modules` + `package.json` |
| `check_env` | Undefined environment variables | `.env*` files |
| `check_types` | Hallucinated TypeScript types/members | Project `.ts`/`.tsx` files |
| `check_routes` | Non-existent API routes, wrong methods | Next.js App Router `route.ts` files |

All checkers auto-detect — no flags needed. If a project has no Prisma schema, that checker silently returns nothing.

### `verify_plan` (optional, requires API key)

Full pipeline: all static checks + LLM review by a separate Claude instance. Use this for deep plan review (intent drift, wrong abstractions, missing requirements). Requires `ANTHROPIC_API_KEY`.

## What the Output Looks Like

When Arthur finds a hallucinated Prisma model:

```
✗ prisma.engagement — hallucinated-model → prisma.participantEngagement
  Available models: participant (Participant), contentItem (ContentItem),
                    participantEngagement (ParticipantEngagement)
```

When Arthur finds a hallucinated file path:

```
✗ src/models/User.ts — NOT FOUND
  Closest: src/lib/db.ts, src/app/api/participants/route.ts
```

When Arthur finds a wrong relation:

```
✗ include: { comments } — wrong-relation
  Available relations on ContentItem: author → Participant, engagements → ParticipantEngagement
```

Claude Code reads these findings and knows exactly what to use instead. No guessing, no second tool call.

## Benchmark Results

### Static Analysis vs Self-Review (Opus 4.6)

11 prompts across 4 fixtures, 5 checker categories. Self-review had the full project tree, all schema files, and a maximally adversarial prompt.

| Category | Errors Found | Self-Review Missed | Self-Review Detection Rate |
|----------|-------------|-------------------|--------------------------|
| Path | 30 | 11 | 63% |
| Schema (Prisma) | 19 | 0 | 100% |
| SQL Schema (Drizzle) | 15 | 15 | 0% |
| Import | 22 | 5 | 77% |
| Env | 7 | 0 | 100% |
| **Total** | **93** | **37** | **60%** |

Self-review missed 37 errors that Arthur caught deterministically. SQL schema references were a complete blind spot — 0% detection. 2.2% false positive rate.

### Schema Hallucination Detail

Fixture: Next.js + Prisma with non-obvious naming (`Participant` not `User`, `participantEngagement` not `engagement`).

| Task | Schema Refs | Hallucinated | Rate |
|------|------------|-------------|------|
| Analytics dashboard | 11 | 3 | 27.3% |
| Recommendation engine | 18 | 4 | 22.2% |
| CSV export | 7 | 1 | 14.3% |
| **Avg** | **12** | **2.7** | **21.3%** |

Recurring hallucination: `prisma.engagement` (should be `prisma.participantEngagement`) appeared in all 3 runs — systematic bias, not random noise.

## CLI (alternative to MCP)

```bash
npm install -g arthur-mcp

# Full verification (static analysis + LLM review)
codeverifier verify --plan plan.md --project ./my-app

# Set API key for LLM verification
codeverifier init
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
npm run bench:big         # Static analysis vs self-review
npm run bench:tier1       # Path + schema hallucination detection
npm run bench:tier2       # Intent drift detection
npm run bench:report      # Generate markdown report
```

## License

MIT
