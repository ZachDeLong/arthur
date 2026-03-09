# Arthur

Inspired by Quantum Merlin-Arthur (QMA) verification, Arthur is a deterministic ground truth verification method for AI-generated code. It catches hallucinated file paths, schema references, imports, env vars, routes, and package API usage before code gets written.

## The Problem

AI coding assistants hallucinate. They reference files that don't exist, query database columns that aren't real, import packages that aren't installed, and build plans on assumptions that don't match the actual codebase.

The model can't reliably catch its own mistakes. Self-review is limited by the same context constraints and attention budget that caused the hallucinations in the first place.

Arthur runs deterministic checks against ground truth (your actual files, schemas, packages, env vars) and returns the results, including what actually exists, so the model can self-correct.

## Install

```bash
claude mcp add arthur -- npx arthur-mcp
```

Arthur is now available as an MCP server in Claude Code. All tools run locally. No API key, no credits, no config.

## How It Works

1. Claude Code generates a plan
2. Claude Code calls Arthur's `check_all` tool
3. Arthur validates every reference against ground truth (file tree, schemas, node_modules, .env files, routes)
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

Runs all stable checkers in a single call. Returns a comprehensive report with ground truth context for every finding.

```
check_all(planText, projectDir)
```

### `check_diff`

Validates actual code changes from a git diff against project ground truth. Use after writing code.

```
check_diff(diffRef, projectDir)
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
| `check_routes` | Non-existent API routes, wrong methods | Next.js App Router `route.ts` files |
| `check_express_routes` | Wrong Express/Fastify routes | Express/Fastify route registrations |
| `check_package_api` *(experimental)* | Wrong named imports/member access | Package `.d.ts` exports in `node_modules` |

All checkers auto-detect. If a project has no Prisma schema, that checker silently returns nothing.

### `verify_plan` (optional, requires API key)

Full pipeline: all static checks + LLM review by a separate Claude instance. Requires `ANTHROPIC_API_KEY`.

## CLI

```bash
npm install -g arthur-mcp

# Static analysis only (no API key needed)
arthur check --plan plan.md --project ./my-app
arthur check --plan plan.md --project ./my-app --strict

# Verify code changes
arthur check --diff HEAD --project ./my-app
arthur check --diff origin/main --project ./my-app

# Full verification (static + LLM review)
codeverifier verify --plan plan.md --project ./my-app
```

## Development

```bash
git clone https://github.com/ZachDeLong/arthur.git
cd arthur
npm install
npm run build
npm test
```

## License

MIT
