# Benchmark Methodology

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
Self-review comparisons give Arthur access to the full filesystem while self-review may receive limited context. This tests realistic conditions but is not a controlled comparison of methods.

### Known false positive rates
- Package API checker: ~54% false positive rate for React re-exports
- Type checker: ~98% false positive rate (disabled by default)
- SQL schema checker: false positives on English phrases matching SQL patterns

## Reproducibility

- Tier 1 and Tier 2 benchmarks are fully reproducible: `npm run bench:tier1`, `npm run bench:tier2`
- Big benchmark requires an Anthropic API key: `npm run bench:big`
- Tier 4 requires access to external project (counselor-sophie) and is not publicly reproducible
- Benchmark results in `bench/results/` are gitignored (local only)
