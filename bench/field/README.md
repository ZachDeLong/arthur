# Field Benchmark

This directory defines Arthur's release-decision benchmark. It is intentionally
separate from fixture mutations and historical repository sweeps.

The study must be committed before collection starts. After that commit, changes
to the protocol create a new version; they never rewrite an active study.

Read [`PROTOCOL.md`](PROTOCOL.md) for the complete design and
[`study-plan.json`](study-plan.json) for the machine-readable stopping and
decision rules.

No field result may be described as independent until the anonymized labels and
adjudication records have been completed by reviewers who did not implement the
Arthur checker being evaluated.
