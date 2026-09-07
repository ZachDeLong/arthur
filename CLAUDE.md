# Arthur

Arthur is a reference-integrity gate for AI-written code.

The product is not a general AI reviewer. Arthur's job is narrower: when an AI
cites a code reference, check whether that reference exists in local ground
truth and return the closest real values when it does not.

**npm package:** `arthur-mcp`
**Install:** `claude mcp add arthur -- npx arthur-mcp`
**Direction doc:** `docs/DIRECTION.md`

## Product Frame

Arthur stops AI from citing things that do not exist.

For code, those citations are:

- file paths
- imports and package subpaths
- Prisma models, fields, methods, and relations
- SQL/Drizzle tables and columns
- Supabase tables, columns, RPC functions, and enums
- environment variables
- Next.js, Express, and Fastify routes
- package API exports and members

Arthur should stay deterministic by default. LLM review exists as an optional
wrapper, but the core value is local ground truth, zero API key, low cost, and
high precision.

## Architecture

```text
bin/
  arthur.ts         Non-interactive CLI: arthur check
  codeverifier.ts   Optional LLM review wrapper
  arthur-mcp.ts     MCP server over stdio

src/
  analysis/         Static analysis checkers and registry
    checkers/       Checker registration files
    registry.ts     CheckerDefinition, registerChecker, getCheckers
    typescript-source.ts  AST-backed source reference extraction
  diff/             Git diff resolver
  commands/         CLI commands
  config/           Global/project/env config
  context/          Project context builder for optional LLM review
  plan/             Plan loading
  session/          Optional verification/session feedback
  verifier/         Optional Anthropic review wrapper

bench/
  fixtures/         Small test projects
  harness/          Benchmark runners and scoring
  validation/       Manually labelled precision regression corpus
  tier3/, tier4/    Research benchmarks, not product surface
```

No tsconfig path aliases. Use relative imports.

## Primary Workflows

### Diff Gate

This is the product direction.

```bash
arthur check --diff HEAD --project .
arthur check --diff HEAD --staged --project .
arthur check --diff origin/main --project .
```

`check_diff` validates changed lines from a git diff. Imports, env vars, and
Next.js routes use TypeScript AST extraction and return source locations. Staged
mode reads index contents; working-tree mode includes untracked files by default.

### Plan Support

```bash
arthur check --plan plan.md --project .
cat plan.md | arthur check --project .
```

`check_all` is useful before implementation, but it should not be the public
center of gravity. Agents forget to call planning tools; hooks and CI do not.

### Optional LLM Review

```bash
codeverifier verify --plan plan.md --project .
```

`verify_plan` and `codeverifier` remain optional. Do not lead with them in the
product story.

## MCP Tools

Arthur exposes two MCP tools by default:

- `check_diff` - changed-line reference gate; primary product
- `check_all` - plan-mode combined static checks

Compatibility and optional surfaces are explicit environment opt-ins:

- `ARTHUR_MCP_LEGACY_TOOLS=1` adds individual checker tools:
  - `check_paths`
  - `check_schema`
  - `check_sql_schema`
  - `check_supabase_schema`
  - `check_imports`
  - `check_env`
  - `check_routes`
  - `check_express_routes`
  - `check_package_api` - experimental
- `ARTHUR_MCP_ENABLE_LLM_TOOL=1` adds `verify_plan` and requires `ANTHROPIC_API_KEY`.
- `ARTHUR_MCP_ENABLE_SESSION_TOOLS=1` adds the two session-context helpers.

Critical MCP rule: never use `console.log()` in `arthur-mcp.ts`. Stdout is the
JSON-RPC transport. Use `console.error()` for diagnostics.

## CLI Behavior

- Plan input: `--plan <file>`, `--stdin`, or piped stdin.
- Diff input: `--diff <ref>` resolves relevant changed files from git.
- `--staged` checks staged index contents only; `--no-untracked` excludes untracked files.
- `--diff` and `--plan` are mutually exclusive.
- Output: `text`, versioned `json`, or SARIF 2.1.0.
- Experimental checkers: `--include-experimental` enables `packageApi`.
- Strict mode: `--strict` defaults coverage mode to `fail`; experimental rules
  remain explicitly opt-in.
- Exit code: `0` for clean or warning-only results, `1` for errors or a failed gate.

## Build And Test

```bash
npm run check
npm test
npm run validate
npm run build
npm run publish:check
```

Development shortcuts:

```bash
npm run arthur -- check --plan plan.md --project .
npm run arthur -- check --diff HEAD --project .
npm run mcp
```

## Current Roadmap

Arthur's core pivot is from plan verifier to automatic reference-integrity gate
for AI-written code.

### Phase 1: Make Diff Mode Real

- [x] `CheckerInput` abstraction supports `plan` and `source` modes.
- [x] `src/diff/resolver.ts` resolves changed lines, staged index data, deletions, and untracked files.
- [x] `arthur check --diff HEAD --project .`
- [x] `arthur check --diff HEAD --staged --project .`
- [x] `check_diff` MCP tool.
- [x] Import checker source mode with per-file attribution and locations.
- [x] Env var source mode.
- [x] Route source mode.
- [ ] Prisma/Supabase/SQL source mode for changed query code.

### Phase 2: Make Arthur Automatic

- [x] `arthur hooks install` for pre-commit checks.
- [ ] Optional Claude Code-specific hook adapter.
- [x] GitHub Actions CI and SARIF output.
- [x] `--quiet` output for clean diffs and managed hooks.

### Phase 3: Precision Gates

- [ ] Per-checker `enabled` / `warn` / `fail` policy.
- [x] Keep noisy checkers experimental until precision improves.
- [x] Maintain separate fixture and historical field-validation records.
- [x] Track precision separately from unlabeled historical checks.

### Phase 4: Adapters, Not Scope Creep

- MCP remains an adapter.
- CLI remains the stable core.
- Future citation verticals should be separate packages or plugins unless they
  cleanly reuse the same reference-gate core.

## Benchmarks

The benchmark system is useful research, not a headline proof.

Known limitation: Arthur's benchmarks often use Arthur's own checkers as ground
truth, so they measure whether another reviewer agrees with Arthur's
classification. They do not independently prove Arthur's precision.

Known false-positive risks:

- `packageApi`: React and package re-export patterns.
- `sqlSchema`: English phrases that resemble SQL references.

Keep benchmark claims humble and point readers to `bench/METHODOLOGY.md`.

The controlled comparison is `bench/paired/`: case inputs and labels are
SHA-256 locked separately before prediction, selection is exhaustive within the
declared artifacts, and Claude runs repeatedly. The first 80-case result showed
no blocking accuracy difference: Arthur and Claude Sonnet 5 were both perfect.
Arthur's measured advantage was local latency and zero API use, not accuracy.
Run it with `npm run bench:paired -- arthur` or, with an API key,
`npm run bench:paired -- all 3`.

The release-decision study is `bench/field/`. Protocol v1 was publicly activated
at commit `2d914e5` before collection. Use `npm run bench:field -- --help`; never
edit v1's protocol, cohort, or thresholds. The collector closes the cohort
before comparison, uses a separate inventory implementation, creates detector-
blind review packets, and refuses to score without two independent reviews,
required adjudication, baseline attribution, and retention decisions.

## Config

- Global config: `~/.arthur/config.json`
- Project config: `.arthur/config.json`
- API key env: `ANTHROPIC_API_KEY`
- Legacy global config `~/.codeverifier/config.json` is still read with a
  deprecation warning.
- Default token budget for optional LLM review: 80k.

## Adding A Checker

The registry pattern makes a new checker a small, explicit addition:

1. Create `src/analysis/my-checker.ts` with the analysis logic.
2. Create `src/analysis/checkers/my-checker.ts` and call `registerChecker()`.
3. Add `import "./my-checker.js"` to `src/analysis/checkers/index.ts`.

Stable checkers are included in `check_all`, `arthur check`, `verify_plan`, and
catch logging. Experimental checkers are included only when requested through
`includeExperimental` or `--include-experimental`.

## Gotchas

- Plans are non-deterministic; benchmark drift replacement can fail to match.
  Record those cases as skipped, not missed.
- In plan mode, package declarations describe intended dependencies. In source
  mode, declared-but-uninstalled packages are warnings, not verified imports.
- Diff refs are passed to `git` via `execFileSync`; keep validation strict.
- MCP stdout is protocol output. Diagnostics go to stderr.
- Prefer source-mode checks for new product work. Plan-mode checks are support,
  not the long-term gate.
