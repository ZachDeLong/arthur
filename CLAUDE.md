# Arthur

Independent verification layer for AI-generated coding plans.

## Architecture

```
src/
  commands/     CLI commands (verify, init)
  config/       Config management (global + project + env)
  context/      Project context builder (tree, file reader, token budget)
  plan/         Plan loading (file, stdin, interactive)
  session/      Session feedback storage (iterative re-verification)
  verifier/     Prompt construction, API streaming, output rendering

bench/
  fixtures/     Test projects with known structures (fixture-a: TS, fixture-b: Go, fixture-c: Next.js+Prisma)
  harness/      Benchmark runner, scoring, detection parsing, schema checking
  prompts/      Benchmark prompts + drift specs
  naive-prompt.ts   Frozen baseline prompt (DO NOT MODIFY)
bench/
  tier3/
    prompt.md         Refactoring prompt for both arms
    scripts/          setup, verify-plan, evaluate, compare
    workspaces/       Gitignored — created by setup at ~/.arthur-tier3-workspaces/
    results/          Gitignored — per-run timestamped results
```

## Build & Run

- `npm run build` — compile TypeScript (also verifies types)
- `npm run dev` — run CLI via tsx
- `npm run bench` or `npm run bench:tier1` — run Tier 1 (hallucination detection)
- `npm run bench:tier2` — run Tier 2 (intent drift detection)
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

## Gotchas

- `.*` in JS regex doesn't cross newlines — use `[^#]*` or `[\s\S]*?` for multi-line section matches
- Plans are non-deterministic — `replace`-based drift injections may fail to match. Record as "skipped", not "missed".
- ACT/SAT-style numeric extractions from LLMs may return decimals — round before storing.
