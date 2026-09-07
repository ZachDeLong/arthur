# Benchmark Methodology

## Current evidence hierarchy

Arthur's release-decision study is preregistered in
[`field/PROTOCOL.md`](field/PROTOCOL.md). It requires consecutive real
agent-authored diffs and blinded independent adjudication. Until that study is
complete, fixture and LLM-comparison benchmarks are regression or controlled
comparison evidence only, not proof of real-world incremental value.

## Current Decision Benchmark

`bench/paired/` is the current controlled comparison. It freezes mechanically
derived cases and labels before prediction, stores labels separately from model
inputs, uses exhaustive selection rules, runs Claude repeatedly, and reports
confidence intervals plus paired tests. Its first result found no blocking
accuracy difference between Arthur and Claude Sonnet 5.

The older Tier 1, Tier 2, Big, self-review, and Tier 4 studies remain research
and regression artifacts. They must not be used for product comparison because
Arthur defines their candidate finding set.

## Legacy Benchmark Limitation

The older Tier 1, Tier 2, Big, self-review, and Tier 4 benchmarks use Arthur's
own checkers as ground truth. This means:
- Arthur always scores 100% detection by definition — it found the errors because it defined them
- Self-review is scored against Arthur's classification, not independent verification
- Precision (are Arthur's "errors" actually real problems?) is not measured in any benchmark
- The only way to verify precision is human review of individual findings

Those legacy benchmarks measure: "given what Arthur classifies as errors, how
many does self-review also find?" They do NOT measure: "how many real errors
does Arthur find?" Those are different questions. The paired benchmark avoids
that circular scoring for its locked mutation cases; the field protocol is
designed to answer the real-world question.

Big Benchmark reports therefore use the terms **checker finding**, **review
mention**, and **unmatched finding**. An unmatched finding is not an Arthur win
until a human confirms both that the finding is real and that the review did
not catch it semantically.

## Limitations

These benchmarks have known methodological limitations that should be considered when interpreting results:

### Self-referential ground truth
Arthur's own checkers define what counts as a hallucination. The benchmark measures whether self-review agrees with Arthur's ground truth. This means Arthur's precision cannot be measured from these benchmarks alone — independent human review is needed.

### Single-run results
Most benchmark results come from single runs of non-deterministic LLM processes. No confidence intervals are provided. Results can vary significantly between runs.

### Adversarial fixtures
Some fixtures (particularly fixture-c) use deliberately non-obvious naming to maximize hallucinations. This is a valid stress test but not representative of typical codebases.

### Curated tasks
Tier 4 tasks were chosen by the benchmark author with knowledge of which schema areas would produce hallucinations. Tasks are not randomly sampled.

### Information asymmetry in comparisons
- **Tier 4:** Self-review gets only CLAUDE.md + task description (same as plan generation). Arthur gets the full filesystem. This is realistic but not a controlled comparison of methods.
- **Big Benchmark:** Self-review gets the same full project context as Arthur plus an adversarial prompt. The comparison is fairer here, but the prompt instructs self-review what to look for.

### Known false positive rates
- Package API checker: ~54% false positive rate for React re-exports
- SQL schema checker: false positives on English phrases matching SQL patterns

## Reproducibility

- Tier 1 and Tier 2 benchmarks are fully reproducible: `npm run bench:tier1`, `npm run bench:tier2`
- Big benchmark requires either `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`: `npm run bench:big`
  If both are set, Anthropic remains the backward-compatible default; set
  `ARTHUR_BENCH_PROVIDER=openai` to choose OpenAI. Override the provider's
  default model with `ARTHUR_BENCH_MODEL`.
- Sonnet 5 runs use adaptive thinking at medium effort with a 16,000-token
  output ceiling. Truncated responses are rejected rather than scored.
- Saved Big Benchmark responses can be rescored without another API call after
  checker or matching fixes: `npm run bench:big:rescore -- <results-directory>`.
  The original files are preserved and updated output is written under
  `rescored-current/`.
- Tier 4 requires access to external project (counselor-sophie) and is not publicly reproducible
- Benchmark results in `bench/results/` are gitignored (local only)
