# Arthur

Ground truth verification for AI-generated code. MCP server that catches hallucinated references before code gets written — deterministically, zero cost, no API key.

**npm package:** `arthur-mcp` | **Install:** `claude mcp add arthur -- npx arthur-mcp`

## Architecture

```
bin/
  codeverifier.ts   CLI entry point
  arthur-mcp.ts     MCP server (stdio transport, 12 tools)

src/
  analysis/     Static analysis checkers + registry pattern
    checkers/   Checker registration files (one per checker, auto-registered via barrel import)
    registry.ts Checker registry (CheckerDefinition interface, registerChecker/getCheckers)
  commands/     CLI commands (verify, init)
  config/       Config management (global + project + env)
  context/      Project context builder (tree, file reader, token budget)
  plan/         Plan loading (file, stdin, interactive)
  session/      Session feedback storage (iterative re-verification)
  verifier/     Prompt construction, API streaming, output rendering

bench/
  fixtures/     Test projects (fixture-a: TS, fixture-b: Go, fixture-c: Next.js+Prisma, fixture-d: Drizzle+SQL, fixture-e: Express)
  harness/      Benchmark runner, scoring, detection parsing
  prompts/      Benchmark prompts + drift specs
  naive-prompt.ts   Frozen baseline prompt (DO NOT MODIFY)
  tier3/        Real-world refactoring benchmark (hybrid: automated setup + manual sessions)
```

## MCP Server

Twelve tools (registry-driven — adding a new checker is a 2-file operation):
- **`check_all`** — runs all 9 deterministic checkers in one call, returns comprehensive report with ground truth (no API key). **This is the primary tool.**
- `check_paths` — path validation against project tree + closest matches (no API key)
- `check_schema` — Prisma schema validation + full schema ground truth (no API key)
- `check_sql_schema` — Drizzle/SQL schema validation + full table/column listing (no API key)
- `check_supabase_schema` — Supabase `database.types.ts` validation: tables, columns, functions, enums (no API key)
- `check_imports` — package import validation + installed packages listing (no API key)
- `check_env` — env variable validation + all defined vars (no API key)
- `check_types` — TypeScript type validation + available types listing (no API key)
- `check_routes` — Next.js App Router route validation + all routes listing (no API key)
- `check_express_routes` — Express/Fastify route validation with mount prefix resolution (no API key)
- `verify_plan` — full pipeline: all static checks + LLM review (requires ANTHROPIC_API_KEY)
- `update_session_context` / `get_session_context` — session persistence across context compression

**Install:** `claude mcp add arthur -- npx arthur-mcp`

**Critical:** No `console.log()` in `arthur-mcp.ts` — stdout is JSON-RPC protocol. Use `console.error()` for debug output.

## Build & Run

- `npm run build` — compile TypeScript (also verifies types)
- `npm run dev` — run CLI via tsx
- `npm run mcp` — run MCP server via tsx (for development)
- `npm run bench:big` — run big benchmark (static analysis vs self-review, all prompts)
- `npm run bench:big -- 06 09` — run big benchmark on specific prompts
- `npm run bench:big:report` — regenerate report from latest big benchmark results
- `npm run bench:tier1` — run Tier 1 (hallucination detection)
- `npm run bench:tier2` — run Tier 2 (intent drift detection)
- `npm run bench:report` — generate markdown report from existing results
- `npm run bench:self-review` — run self-review vs Arthur comparison
- `npm run bench -- tier3` — print the full T3 workflow instructions
- No tsconfig path aliases — use relative imports

## Key Conventions

- **Naive prompt is frozen** — `bench/naive-prompt.ts` must never be modified. It's the reproducible baseline.
- **Results dir is gitignored** — benchmark results in `bench/results/` are local only.
- **Config locations** — global: `~/.codeverifier/config.json`, project: `.codeverifier/config.json`, env: `ANTHROPIC_API_KEY`
- **Token budget** — default 80k. Priority order: prompt > plan > README > CLAUDE.md > session feedback > referenced files > tree.
- **Model default** — `claude-sonnet-4-5-20250929` (Sonnet 4.5). Override via project config `.codeverifier/config.json`.
- **Fixture src/ excluded from root tsconfig** — `bench/fixtures/*/src` is excluded because fixture source files have their own deps (Next.js, Prisma, etc.).

## Benchmark System

### Tier 1: Hallucination Detection
Generates plans with README-only context, then verifies against full project tree. Checks paths and schema references.

- Fixture-c uses non-obvious naming (Participant not User, displayIdentifier not username) to tempt hallucinations
- Detection via 4-tier parsing: direct match → sentiment → section → directory correction

### Tier 2: Intent Drift Detection
Injects synthetic drift into generated plans. Measures whether the verifier catches it.

- **Drift specs**: `bench/prompts/drift-specs.json` — each spec applied independently
- **Replace-based specs are fragile** — regex patterns must account for non-deterministic LLM output. `append` is always reliable.

### Big Benchmark: Static Analysis vs Self-Review
Measures what self-review misses across all checker categories. Self-review gets the same full context and an adversarial prompt.

- **Runner**: `bench/harness/big-benchmark-runner.ts`
- **Ground truth**: `bench/harness/ground-truth.ts`
- **Prompt**: `bench/prompts/big-benchmark-prompt.ts`
- **Report**: `bench/harness/big-benchmark-report.ts`
- Run with: `npm run bench:big` or `npm run bench:big -- 06 07 08 09 10 11`

### Tier 3: Real-World Refactoring Verification
Hybrid benchmark — automated setup + manual Claude Code sessions.

- **Workspaces live at `~/.arthur-tier3-workspaces/`** — NOT inside `~/arthur/` (prevents CLAUDE.md contamination)
- **Must commit workspace changes before eval** — `evaluate.ts` uses `git diff HEAD~1`

## Future Checkers (Roadmap)

Priority order based on hallucination severity (schema > routes > imports > types):

1. ~~**Express/Fastify route checker**~~ — **DONE** (v0.4.0). `check_express_routes` tool with mount prefix resolution.
2. **Raw SQL migration scanner** — scan `/migrations` folders for CREATE TABLE statements. `sql-schema-checker.ts` already parses CREATE TABLE, just needs to find migration files.
3. **Python import checker** — validate `import` / `from X import Y` against pip packages in `requirements.txt` / `pyproject.toml`.
4. **Python type checker** — validate references to Python classes, dataclasses, Pydantic models.
5. **Additional ORMs** — TypeORM, Sequelize, SQLAlchemy schema parsing.
6. **SvelteKit/Remix route checker** — file-based routing similar to Next.js but different conventions.

## Adding a New Checker

With the registry pattern, adding a checker is a 2-file operation:

1. Create `src/analysis/my-checker.ts` — the analysis logic (exports `analyzeMyThing()`)
2. Create `src/analysis/checkers/my-checker.ts` — imports `registerChecker()`, wraps the analysis in a `CheckerDefinition`
3. Add `import "./my-checker.js"` to `src/analysis/checkers/index.ts`

The checker is automatically included in `check_all`, `verify_plan`, and catch logging.

## Gotchas

- `.*` in JS regex doesn't cross newlines — use `[^#]*` or `[\s\S]*?` for multi-line section matches
- Plans are non-deterministic — `replace`-based drift injections may fail to match. Record as "skipped", not "missed".
- **No `console.log()` in MCP server** — stdout is JSON-RPC. Use `console.error()`.
- **Fixtures don't have node_modules** — import checker must fall back to package.json deps. Already implemented.
- **SQL FROM regex matches comments inside code blocks** — English stopword list handles known cases but isn't exhaustive.
- **Type checker disabled in benchmark** — 98% FP rate from inline backticks. Needs structural fix: fenced code blocks only, syntactic positions. MCP tool `check_types` still works individually.
