# Historical Field Validation

This file records supplemental repository-level checks. These results are kept
separate from the labelled fixture corpus because historical commits do not
provide ground-truth labels for missed defects.

## 2026-09-06 — ZachDeLong/school-checklist

- Repository head: `5d056ae8ec2bc0e546d9b5c015edd9819b539ad1`
- Range: 37 parent-to-child diffs, from `d95f971c109a94a76437279b555082b56e035cc2`
  through head (the root commit was excluded)
- Relevant changed files resolved: 114
- Static references checked: 49 across 10 commits
- Confirmed errors: 0
- Confirmed warnings: 0
- Confirmed false positives: 0
- Compiled-CLI latency on Windows: 504 ms p50, 540 ms p95, 553 ms maximum

The initial sweep reused the head commit's installed dependencies and produced
one `declared-not-installed` warning for `@vercel/node` at commit `cf5c647`.
After running `npm ci` from that commit's lockfile, Arthur checked two imports
and produced no findings. The warning was therefore dependency-environment
drift in the evaluation setup, not a blocking finding.

### Interpretation

This is evidence that the blocking rules did not create noise on one real
project's clean historical changes. It does **not** establish 100% precision:
there were no positive findings to classify, the commits were not independently
labelled, and recall cannot be inferred from clean history. The continuation
criteria still require agent-authored changes across multiple repositories and
feedback from external developers.
