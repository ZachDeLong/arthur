# Arthur Direction

Arthur is a reference-integrity gate for AI output.

The code product is the first vertical: AI-written code frequently cites local
references that do not exist. Arthur checks those citations against deterministic
ground truth.

## Core Frame

When an AI says a thing exists, Arthur asks:

1. Does that thing actually exist in the source of truth?
2. If not, what nearby real thing should the agent use instead?

For code, "thing" means paths, imports, schemas, routes, env vars, package APIs,
and other local references.

For future verticals, the same frame could apply to book quotes, legal citations,
research-paper citations, documentation claims, or any other AI output that cites
an external source.

## Product Boundary

Arthur should not become a general AI reviewer.

Arthur should not judge style, architecture, taste, or implementation quality.
Those are agent and reviewer jobs.

Arthur should be excellent at one narrow job: catching invented references and
returning the real ground truth.

## Current Vertical: Code

The current repo should stay focused on JavaScript and TypeScript projects until
the core gate is strong.

Primary workflows:

1. `arthur check --diff` for changed code.
2. `check_diff` for MCP hosts.
3. `arthur check --plan` and `check_all` as useful planning-time support.

Demoted workflows:

1. `verify_plan` and `codeverifier` remain optional wrappers, not the product.
2. Benchmarks are research artifacts, not the headline claim.
3. Session memory tools are adapter support, not Arthur's core identity.

## Near-Term Roadmap

### Phase 1: Make Diff Mode Real — Implemented In 0.6

- Read staged content from the Git index and include untracked working-tree files.
- Check only changed lines while retaining full-file parser context.
- Support imports, env vars, and Next.js routes with AST-backed source extraction.
- Attach file, line, and column locations to findings.
- Keep unsupported checkers explicitly skipped in source mode.

### Phase 2: Make Arthur Automatic — Implemented In 0.6

- `arthur hooks install` adds a safe, quiet pre-commit gate.
- SARIF 2.1.0 output supports code-scanning adapters.
- The repository CI matrix covers supported Node.js LTS versions on Linux and Windows.
- Existing user-owned Git hooks are never overwritten.

### Phase 3: Precision As The Product — Current Validation Gate

- Evaluate against real agent-authored changes on external repositories.
- Commit the preregistered field protocol in `bench/field/PROTOCOL.md` before
  collecting data; do not change its cohort or pass/fail rules after activation.
- Keep unlabeled historical sweeps separate from precision/recall metrics; the
  first 37-diff field sweep is documented in `bench/validation/FIELD_RESULTS.md`.
- Keep blocking-rule precision at or above 98% and p95 hook latency below three seconds.
- Keep `packageApi` experimental until common re-export patterns are handled.
- Maintain separately labelled regression and real-world false-positive corpora.
- Track precision separately from recall-oriented benchmark results.

### Phase 4: Adapters, Not Scope Creep

- MCP stays as an adapter.
- CLI stays as the stable core.
- Future citation verticals should be separate packages or plugins unless they
  reuse the same reference-gate core cleanly.

## Continuation Criteria

Continue beyond the 0.6 validation release only if real-world evaluation shows:

1. At least 50 agent-authored changes checked across multiple repositories.
2. At least five actionable defects missed by compilers, tests, and existing linters.
3. At least 98% precision for blocking rules.
4. At least three external developers keep the gate enabled after trying it.

If those criteria are not met, freeze the product rather than growing its rule
count. The reusable checker and reporting infrastructure can remain available
without pretending that adoption or differentiation was proven.

## Positioning

Short version:

> Arthur stops AI from citing things that do not exist.

Code version:

> Arthur is a deterministic reference-integrity gate for AI-written code.

Developer version:

> Run Arthur before commit or CI to catch invented package imports, env vars,
> and Next.js routes on changed JavaScript and TypeScript lines. Plan mode adds
> broader path and schema checks as non-primary support.
