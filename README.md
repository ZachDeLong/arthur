# Arthur

Independent verification layer for AI-generated coding plans — catches hallucinated file paths and flawed assumptions before code gets written.

## The Problem

AI coding assistants hallucinate file paths. They reference files that don't exist, assume directory structures that aren't there, and build plans on top of wrong assumptions. The model that generated the plan can't catch its own mistakes because it's working from the same flawed context.

## The Approach

Arthur is a fresh pair of eyes. It takes an AI-generated plan, loads the **real** project context (directory tree, README, conventions), and has an independent Claude instance review the plan from scratch. The reviewer has never seen the original conversation — it only sees the plan and the ground truth.

This works because the verifier has something the generator didn't: the actual project structure to check against.

## How It Works

1. You feed Arthur a plan (file, stdin, or paste)
2. Arthur builds a context snapshot of your project — directory tree, README, CLAUDE.md, referenced source files
3. An independent Claude instance reviews the plan against that real context
4. You get back structured feedback: what's wrong, what's missing, what paths don't exist

The production prompt explicitly instructs the verifier to cross-reference every file path in the plan against the project tree and flag anything that doesn't match.

## The Benchmark

We built a benchmark to measure this honestly. Two fixture projects (a TypeScript plugin registry and a Go API gateway) with intentionally hallucination-prone prompts.

**Key finding:** A naive verifier with *zero path-checking instructions* organically detects **31.5%** of hallucinated paths just through context isolation. The model naturally notices that referenced files aren't in the tree — no prompting needed.

The naive prompt is frozen in `bench/naive-prompt.ts` as the baseline. The production prompt (with explicit path verification instructions) is what ships to users for maximum catch rate.

### Benchmark tiers

- **Tier 1** (automated): Hallucination rate in generated plans, detection rate by the verifier
- **Tier 2** (human evaluation): Rubrics for actionability, accuracy, and review quality — requires real domain experts to score

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
  fixtures/     Test projects with known structures
  harness/      Benchmark runner, scoring, detection parsing
  naive-prompt.ts   Frozen baseline prompt (DO NOT MODIFY)
```
