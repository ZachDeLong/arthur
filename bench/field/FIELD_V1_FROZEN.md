# Field v1 frozen prereview snapshot

Status: **frozen; independent review pending**. This is not a result claim.

The preregistered cohort closed on 2026-09-07 with 50 consecutive eligible
agent-authored JavaScript/TypeScript changes across five public repositories.
Each repository contributed 10 captures. Two in-stream changes were retained as
declared exclusions because they contained no JavaScript or TypeScript source
change. The independent inventory contains 20 blinded reference occurrences.

The fixed comparator used `anthropic/claude-sonnet-5` with adaptive thinking at
medium effort. Anthropic documents that model ID as a pinned canonical model
release. The run used 13,411 input tokens and 1,771 output tokens, cost an
estimated $0.044532 at the published $2/$10 per-million-token rates recorded at
collection close, and produced 20 predictions. Prediction contents were frozen
before any human labels existed.

## Known decision-rule limitation

All 50 captures record the same represented developer ID, `zachd`. The frozen
release rule requires at least three represented external developers to record
that they would keep the gate enabled, while the study CLI accepts at most one
retention record per represented developer ID. Field v1 therefore cannot pass
the all-conditions release decision regardless of its eventual detector
metrics. This cohort will not be reopened or relabelled to hide that limitation;
its precision, recall, latency, and paired-comparator results remain worth
completing and publishing.

## Integrity receipt

- Activation commit: `2d914e5e41637726dbb440dda4aed47ea148febb`
- Study lock: `4920ee235e2eb084f29b1c682860426b84052603d547d561a503b6db828a474a`
- Capture index: `f39d20f3ee412e0f319a1cd3102c7e7bd2df441b53e4cd37fe7278ce4e1a22c0`
- Case inventory: `8652e62aa3fc996ba58116fe8ae08771995276b2f67b87319bf9d3db0879dcaf`
- Arthur predictions: `752d2e075477c0a4657f334c8ef1f988d257887082e4f0779548f52c4fb5d5d1`
- Comparator run: `ebdfa4eb0d0698ef7016d72557b2a66c85225e4b4ead0a9e4c840f06424ac9dc`
- Comparator predictions: `403b41b642c6a3aa03ac7781c50cb8844ec21c92a1691c39e8ce65005e8a174a`
- Blind review packets: `0a0d5b25f7713d0d322c52bce3a44a02f1ae95c244a7554ab3253fec82402cda`
- Standard-tool evidence: `9487e08f9611b31506cb1bf3025143c0c722004577b8262365f2714a90da5362`
- Freeze audit head: `6f73a690773471ce687190c396189853a16fc70a958ffd5f73d71709d7d5a6e2`

The publication snapshot is under `bench/results/field-v1/`. Reviewers must
receive only `frozen/review-packets.jsonl`,
`frozen/standard-tool-evidence.json`, and their blank submission template. They
must not open either detector-prediction file until their submissions are
locked.

The preregistered decision cannot be scored until two eligible independent
reviewers submit labels, a different reviewer adjudicates every disagreement or
uncertain label, an independent assessor groups confirmed occurrences into
underlying defects, and represented external developers record retention
decisions before aggregate results are revealed.
