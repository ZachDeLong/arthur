# Paired Reference-Integrity Benchmark

This benchmark compares Arthur and an LLM against the same locked labels. It
was added after the older Big Benchmark showed that using Arthur's own findings
as "ground truth" creates circular, confirmation-biased results.

## Anti-bias design

- Labels are frozen before prediction and stored separately from case inputs.
- Prediction code reads `cases.json`, never `labels.json`.
- Case IDs are hashes and reveal neither the expected outcome nor variant.
- Selection is exhaustive, not hand-picked: every direct runtime dependency in
  Arthur's `package.json`, every env variable in fixtures b/c/d, and every
  exported method in fixture-c's App Router routes is included.
- Each reference produces the same four variants: valid live use, a
  deterministic one-character invalid mutation, the invalid mutation in a
  comment, and the invalid mutation in a documentation string.
- The corpus and every source artifact are SHA-256 locked. Changed fixtures
  require a new benchmark version rather than silently changing old results.
- Claude receives the same relevant package/env/route facts and is run three
  times with independently ordered cases.
- Reporting includes the full confusion matrix, Wilson 95% intervals, exact
  three-way accuracy, all mismatches, and an exact paired McNemar test.

## Commands

```bash
# One-time corpus lock. Refuses to overwrite by default.
npm run bench:paired -- freeze

# Free deterministic prediction + score
npm run bench:paired -- arthur

# Full comparison (requires ANTHROPIC_API_KEY or OPENAI_API_KEY)
npm run bench:paired -- all 3

# Rescore saved predictions without API calls
npm run bench:paired -- score <results-directory>
```

## What this can and cannot establish

This is a trustworthy regression comparison for the narrow syntax and artifact
contracts represented by the locked corpus. Arthur does not define the answers,
and the scorer cannot quietly move the labels after seeing predictions.

It is still a mutation benchmark on repository fixtures. It cannot establish
real-world adoption, the prevalence of these errors, or Arthur's incremental
value over compilers and tests. Those claims require blinded human adjudication
of agent-authored diffs across multiple external repositories. The continuation
criteria in `docs/DIRECTION.md` remain the release gate.

The first locked run is recorded in [`RESULTS.md`](RESULTS.md). It is retained
even though it found no accuracy advantage for Arthur.
