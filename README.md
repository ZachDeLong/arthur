# Arthur

Arthur is a reference-integrity gate for AI-written code.

AI coding agents cite things that may not exist: file paths, imports, database
columns, API routes, env vars, package exports, and schema fields. Arthur checks
those references against ground truth before they become bugs.

The first Arthur vertical is code. The broader idea is simple: when an AI output
cites a source, Arthur verifies that the cited thing is real.

## The Problem

AI coding assistants are good at plausible implementation, but they still invent
references:

- files that are not in the repo
- Prisma models or fields that are not in `schema.prisma`
- Supabase or SQL columns that are not in the generated schema
- packages or import subpaths that are not installed or exported
- env vars that are not defined
- routes that are not registered

LLM self-review can catch these errors. In Arthur's first locked paired
benchmark, Claude Sonnet 5 and Arthur both classified every blocking case
correctly. Arthur's narrower advantage was operational: the local run took
63 ms with no network call, credential, token cost, or run-to-run variance,
while Claude took 30–42 seconds per run. See
[`bench/paired/RESULTS.md`](bench/paired/RESULTS.md).

Arthur uses deterministic checks against local ground truth and returns nearby
real values, so the same narrow checks can run automatically on every change.

## Install

```bash
# CLI and pre-commit hook
npm install --save-dev arthur-mcp

# MCP adapter for Claude Code
claude mcp add arthur -- npx arthur-mcp
```

Arthur runs locally as an MCP server. The deterministic checks need no API key,
account, or remote service; import verification uses the dependencies already
installed in the target checkout.

## Use It As A Gate

Arthur has two useful entry points:

```bash
# Check an implementation plan before code is written
arthur check --plan plan.md --project ./my-app

# Check changed code before commit or in CI
arthur check --diff HEAD --project ./my-app
arthur check --diff origin/main --project ./my-app

# Install a quiet staged-change gate
arthur hooks install --project ./my-app
```

In MCP hosts, use:

```text
check_all(planText, projectDir)
check_diff(projectDir, diffRef)
```

Those are the only tools exposed by default. Existing individual checker tools
can be restored with `ARTHUR_MCP_LEGACY_TOOLS=1`. The networked `verify_plan`
and session helpers require the separate `ARTHUR_MCP_ENABLE_LLM_TOOL=1` and
`ARTHUR_MCP_ENABLE_SESSION_TOOLS=1` opt-ins.

`check_all` is useful while planning. `check_diff` is the primary gate. Diff
mode currently targets JavaScript and TypeScript, reads staged content from
Git's index, includes untracked files by default, checks only changed lines,
and returns source locations for every finding.

## What Arthur Checks

| Checker | Plan | Diff | Ground truth |
|---|---:|---:|---|
| Paths | Yes | Not yet | Project tree |
| Prisma schema | Yes | Not yet | `schema.prisma` |
| SQL/Drizzle schema | Yes | Not yet | `pgTable()` / `CREATE TABLE` |
| Supabase schema | Yes | Not yet | `database.types.ts` |
| Imports | Yes | Yes | Installed package metadata |
| Env vars | Yes | Yes | `.env*` files |
| Next.js routes | Yes | Yes | App Router `route.ts` files |
| Express/Fastify routes | Yes | Not yet | Route registrations |
| Package API *(experimental)* | Opt-in | Not yet | Package `.d.ts` files |

All checkers auto-detect. If a project does not use a supported ground-truth
source, that checker is skipped.

Arthur reports the exact selected, supported, applicable, and skipped checker
sets. A partial diff scan never claims that all project references were
verified. Packages declared in `package.json` but absent from installed ground
truth are warnings rather than silently passing as verified. Import resolution
starts beside each changed source file, so nested npm workspaces and monorepo
packages use their own `package.json` and `node_modules` state.

## Example

```text
Invalid reference:
  prisma.engagement

Ground truth:
  Available models:
    participant -> Participant
    contentItem -> ContentItem
    participantEngagement -> ParticipantEngagement

Suggested correction:
  prisma.participantEngagement
```

```text
Invalid reference:
  src/models/User.ts

Ground truth:
  Closest files:
    src/lib/db.ts
    src/app/api/participants/route.ts
```

Arthur does not decide whether the design is good. It checks whether the AI
cited real things.

## Recommended Setup

Add this to your project's agent instructions:

```markdown
## Reference Integrity

Before implementing a plan, run Arthur's `check_all` against the plan and
project directory. After writing code, run `check_diff` against the changed
files. Fix any invented references using Arthur's ground-truth suggestions.
```

Or install the managed pre-commit hook:

```bash
arthur hooks install
arthur hooks uninstall
```

Arthur will not overwrite an existing hook it does not own. In that case it
prints the one command to add manually.

## CLI

```bash
npm install -g arthur-mcp

# Plan mode
arthur check --plan plan.md --project ./my-app
cat plan.md | arthur check --project ./my-app

# Diff mode
arthur check --diff HEAD --project ./my-app
arthur check --diff HEAD --staged --project ./my-app
arthur check --diff origin/main --project ./my-app

# Machine-readable output
arthur check --diff origin/main --format json
arthur check --diff origin/main --format sarif > arthur.sarif

# Fail closed on low coverage without enabling experimental rules
arthur check --diff HEAD --staged --strict

# Optional LLM review wrapper
export ANTHROPIC_API_KEY=your-key
codeverifier verify --plan plan.md --project ./my-app
```

The deterministic CLI and MCP checks are local. `codeverifier` is a separate,
optional wrapper that sends the assembled plan and referenced source context to
Anthropic using your API credentials.

## CI

Arthur emits SARIF 2.1.0 for GitHub code scanning and other compatible tools.
A minimal pull-request gate is:

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0
- run: npm ci
- run: npx arthur check --diff origin/${{ github.base_ref }} --format sarif > arthur.sarif
```

Arthur exits non-zero for error findings. Warning-only results remain visible
without blocking the build.

## Development

```bash
git clone https://github.com/ZachDeLong/arthur.git
cd arthur
npm ci
npm run check
npm test
npm run validate
npm run build

# Locked, label-separated Arthur vs LLM comparison
npm run bench:paired -- arthur
```

`npm run validate` evaluates the blocking diff rules against a manually labelled
fixture corpus. It is a regression gate, not an independently audited claim of
real-world precision;
a historical sweep of 37 diffs from `ZachDeLong/school-checklist` found no
confirmed false positives, but broader agent-authored and external-user
validation remains required. See
[`bench/validation/FIELD_RESULTS.md`](bench/validation/FIELD_RESULTS.md).
The paired benchmark design, frozen corpus, and non-winning first result are in
[`bench/paired/`](bench/paired/README.md).
The preregistered release-decision study is in
[`bench/field/`](bench/field/README.md). Protocol v1 was publicly activated at
commit `2d914e5` before any data; the included collector locks the cohort,
predictions, blinded reviews, and fixed pass/fail decision.

## Direction

Arthur is not trying to be a general AI reviewer. It is a precise, boring,
deterministic layer for checking references that AI agents cite.

Near-term focus:

1. Validate diff-mode precision on real agent-authored changes.
2. Expand source mode only where a deterministic contract exists.
3. Keep hook latency below the agent workflow's interruption threshold.
4. Keep noisy checkers experimental until precision is proven.

See [docs/DIRECTION.md](docs/DIRECTION.md) for the product direction.

## License

[MIT](LICENSE)
