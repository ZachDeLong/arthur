# Arthur

**A local reference-integrity gate for AI-written JavaScript and TypeScript.**

Arthur checks changed code for references that do not match the repository:
package imports, environment variables, and Next.js API routes. The checks are
deterministic, make no network calls, incur no API usage fee, and need no API
key.

```text
AI writes code  ->  Arthur checks cited references  ->  commit or fix
                         |
                         +-- package metadata
                         +-- .env contracts
                         +-- Next.js route files
```

Arthur is intentionally narrow. It does not judge architecture, style,
security, or whether the implementation satisfies the product requirement. It
checks whether specific things the code cites are actually present in local
ground truth.

> **Project status:** the diff gate and pre-commit hook are usable today.
> Regression results are strong, but independent real-world review is still in
> progress. Arthur does not yet claim proven real-world accuracy or adoption.

## Quick Start

Arthur requires Node.js 22 or newer. Diff checks and hooks also require Git.

```bash
npm install --save-dev arthur-mcp

# Check all uncommitted JS/TS changes against HEAD
npx arthur check --diff HEAD

# Install a quiet check for staged changes before every commit
npx arthur hooks install
```

The managed hook stays quiet when there are no findings; warnings are shown but
do not block. It does not fail for low coverage, fails closed if Arthur itself
cannot run, and will not overwrite a pre-existing hook that Arthur does not
own.

To remove it:

```bash
npx arthur hooks uninstall
```

## What It Catches

Given changed code such as:

```ts
import client from "imaginary-payments-sdk";

const token = process.env.PAYMENT_SECRT;
const response = await fetch("/api/usres");
```

Arthur can report that the package is not installed, the env name is absent
from the applicable `.env*` files, and the route does not exist. Findings carry
file, line, and column locations, plus a nearby real value when Arthur can offer
one.

Diff mode currently checks only static references on added or changed lines:

| Reference | Ground truth | Monorepo behavior |
|---|---|---|
| Package imports and subpaths | Installed package metadata and `package.json` | Resolves upward from the importing file |
| Environment variables | Repository-root and owning-package `.env*` files | Does not accept declarations from sibling packages |
| Next.js App Router calls and methods | `app/**/route.{ts,tsx,js,jsx}` exports | Uses only routes from the source file's package |

Declared packages that are unavailable in `node_modules` are warnings, not
verified imports. Dynamic references that cannot be resolved deterministically
are skipped rather than guessed.

Arthur reports every checker it selected, applied, or skipped. “No findings”
means no problems in the references Arthur actually checked—not that the entire
change is correct.

## Everyday Commands

```bash
# Working tree plus untracked files, compared with HEAD
npx arthur check --diff HEAD

# Staged files only
npx arthur check --diff HEAD --staged

# Everything changed on a branch
npx arthur check --diff origin/main

# Check a different repository
npx arthur check --diff HEAD --project ../my-app

# Structured output
npx arthur check --diff origin/main --format json
npx arthur check --diff origin/main --format sarif > arthur.sarif
```

Error findings exit with status 1. Warning-only results do not block.

By default, low reference coverage produces a warning. Use `--strict` when a
workflow should fail on low coverage; unless project configuration overrides
it, the strict threshold is five checked references:

```bash
npx arthur check --diff origin/main --strict
```

Strict mode changes the coverage gate; it does **not** enable experimental
checkers. Use `--include-experimental` separately. Run
`npx arthur check --help` for the full policy and output options.

## CI

Fetch the target branch, install dependencies, and run the same diff command:

```bash
git fetch origin
npm ci
npx arthur check --diff origin/main
```

Replace `origin/main` with the target branch for the change being checked.

Use `--format json` for custom automation or `--format sarif` for a compatible
code-scanning uploader. Arthur writes the report before returning its blocking
exit status.

## Use Arthur From an AI Coding Agent

Arthur also runs as a local STDIO MCP server. Codex supports this form of MCP
configuration in its CLI, desktop app, and IDE extension; those clients share
the same host configuration. See the
[official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp).

```bash
# Codex
codex mcp add arthur -- npx -y arthur-mcp

# Claude Code
claude mcp add arthur -- npx -y arthur-mcp
```

The default server exposes two tools:

- `check_diff` checks changed code. This is the primary workflow.
- `check_all` checks an implementation plan. This is secondary support before
  code is written.

Both are deterministic and require no API key. A useful agent instruction is:

```markdown
After changing JavaScript or TypeScript, run Arthur's `check_diff` against the
working tree. Fix invalid references using the reported local ground truth.
Treat skipped checkers and low coverage as unverified scope, not a clean bill of
health.
```

## Plan Mode

Plan verification remains available, but it is not Arthur's primary product:

```bash
npx arthur check --plan plan.md --project .
cat plan.md | npx arthur check --project .
```

Plan mode has broader checker coverage because a plan can be compared with the
whole project rather than attributed to individual changed source lines:

| Checker | Plan mode | Diff mode |
|---|---:|---:|
| File paths | Yes | Not yet |
| Package imports and subpaths | Yes | Yes |
| Environment variables | Yes | Yes |
| Next.js App Router routes | Yes | Yes |
| Prisma models and fields | Yes | Not yet |
| SQL/Drizzle tables and columns | Yes | Not yet |
| Supabase tables, columns, functions, and enums | Yes | Not yet |
| Express/Fastify routes | Yes | Not yet |
| Package API declarations | Experimental | Not yet |

Unsupported source-mode checkers are explicitly reported as skipped.

## Evidence, Without the Victory Lap

Arthur keeps three kinds of evidence separate because they answer different
questions:

| Evidence | Current observation | What it does **not** establish |
|---|---|---|
| Maintainer-labelled regression gate | 40/40 exact outcomes; 100% blocking precision and recall | Independent or real-world accuracy |
| Locked 80-case Arthur-vs-Claude benchmark | Both systems made every blocking decision correctly; Arthur ran locally in 63 ms versus 30–42 seconds per Claude run | An accuracy advantage over LLM self-review |
| Preregistered field study | 50 agent-authored changes from five public repositories are frozen; independent blind review is pending | A publishable precision, recall, or incremental-value result |

The regression corpus is designed to prevent known failures from returning. It
now includes sibling-workspace cases for imports, env files, and duplicate API
routes. Its labels were not independently audited, so its 100% result must not
be presented as real-world precision.

The locked paired benchmark supports a speed, cost, and repeatability claim—not
an accuracy claim. See
[`bench/paired/RESULTS.md`](bench/paired/RESULTS.md).

The first field cohort cannot satisfy Arthur's own final release rule because
all represented changes came from one developer; its detector metrics are
still worth completing. A package-resolution evidence flaw discovered after
freeze was recorded as a detector-blind erratum instead of rewriting the
artifacts. See
[`bench/field/FIELD_V1_FROZEN.md`](bench/field/FIELD_V1_FROZEN.md) and
[`bench/field/PROTOCOL.md`](bench/field/PROTOCOL.md).

Until the independent reviews are complete, the honest conclusion is: Arthur
is fast and deterministic, its known root-only import false-positive class has
been fixed, and its incremental value on real agent work is not yet proven.

## Boundaries

Arthur is not a replacement for TypeScript, tests, linters, code review, or a
security scanner. Some of those tools catch overlapping failures. Arthur's
field study is specifically measuring whether the gate finds actionable defects
that normal project checks miss.

Current limitations include:

- Diff mode supports JavaScript and TypeScript only.
- Only imports, env references, and Next.js App Router calls have source-mode
  adapters today.
- Runtime-computed references are intentionally skipped.
- Local ground truth can be incomplete when dependencies are not installed or
  project contracts are missing.
- Plan mode cannot attribute every reference to a specific monorepo package as
  reliably as source mode can.

Precision takes priority over adding more rules. Noisy checks remain
experimental until they can meet the blocking threshold.

## Optional Networked Review

`codeverifier` is a separate, optional LLM wrapper:

```bash
export ANTHROPIC_API_KEY=your-key
npx codeverifier verify --plan plan.md --project .
```

Unlike Arthur's deterministic checks, this command sends the assembled plan and
referenced source context to Anthropic. Review that boundary before using it on
confidential code.

The MCP server keeps legacy individual tools, the LLM tool, and session tools
disabled by default. They can be restored explicitly with:

```text
ARTHUR_MCP_LEGACY_TOOLS=1
ARTHUR_MCP_ENABLE_LLM_TOOL=1
ARTHUR_MCP_ENABLE_SESSION_TOOLS=1
```

## Development

```bash
git clone https://github.com/ZachDeLong/arthur.git
cd arthur
npm ci
npm run prepublishOnly
```

`prepublishOnly` runs the typecheck, build, full test suite, and labelled
validation gate. Benchmark artifacts and methodology live under [`bench/`](bench/),
and the product boundary is documented in
[`docs/DIRECTION.md`](docs/DIRECTION.md).

## License

[MIT](LICENSE)
