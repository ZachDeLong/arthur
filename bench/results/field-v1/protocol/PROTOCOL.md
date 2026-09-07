# Arthur Field Benchmark Protocol — Version 1

Status: **activation by commit**. Before publication this is only a prepared
protocol; it becomes active at the first public Git commit containing this exact
version. Data collection must start afterward.

## Question

Does Arthur catch actionable reference-integrity defects in real AI-authored
JavaScript or TypeScript changes, with little enough noise to remain enabled,
beyond what the project's existing compiler, tests, and linters already catch?

This is the release question. It is not whether Arthur can detect mutations made
for a fixture benchmark, nor whether it agrees with another reviewer.

## Preregistered cohort

Collect the first 50 consecutive eligible changes after activation, subject to:

- at least five repositories;
- no more than 15 changes from any one repository;
- repositories must not be Arthur or an Arthur benchmark fixture;
- each change must contain JavaScript or TypeScript written primarily with an AI
  coding agent and have a recorded base commit and resulting commit or patch;
- the repository must expose enough dependency and project state to reproduce
  the change;
- changes are included before running Arthur, so its output cannot affect
  selection.

An eligible change may be excluded only for a reason listed in
`study-plan.json`. Every exclusion and its reason must remain in the public
study ledger. If a repository reaches the per-repository cap, subsequent changes
from it are recorded but excluded until another repository is added.

## Frozen inputs

For every included change, record before prediction:

1. repository identifier and immutable base/result commit hashes;
2. whether the code was agent-authored and how that was established;
3. the complete diff and relevant lockfiles/configuration;
4. commands for the existing compiler, tests, and linters;
5. hashes of all captured artifacts.

Public data may redact secrets and private business content, but redactions must
be declared and must not remove reference evidence. Private repositories may use
stable anonymized IDs while retaining a reproducible audit bundle.

## Reference inventory and labels

Create an inventory of every changed-line reference in Arthur's supported
blocking domains: imports, environment variables, and Next.js route calls. Do
this for every included diff, including diffs where Arthur reports nothing.

Each occurrence receives a blinded case ID. Review packets must not reveal
Arthur's decision, the comparator's decision, or whether a candidate came from
either system. They include the occurrence, diff context, pinned project state,
and commands needed to inspect the ground truth.

Two reviewers who did not implement the evaluated checker independently assign:

- `valid`: resolves correctly in the pinned project state;
- `actionable_invalid`: would reasonably be fixed before merge;
- `ignored`: comment, documentation string, runtime-provided convention, or
  otherwise outside the blocking contract;
- `uncertain`: insufficient evidence.

They also record whether the existing compiler, tests, or linters catch an
`actionable_invalid` occurrence. Disagreements and all `uncertain` labels go to
a third reviewer. The adjudicator sees the two rationales but remains blind to
detector identity. Original labels and the final decision are all retained.

## Systems under test

Predictions are frozen before reviewers receive packets:

1. Arthur's published build at the activation commit, using default stable
   source-mode rules;
2. the repository's existing compiler, tests, and linters without adding Arthur;
3. one fixed LLM reviewer configuration, prompt, model snapshot, and context
   policy recorded in the study ledger.

Arthur configuration cannot be tuned per repository after viewing labels. A
configuration failure is recorded as a failure, not silently excluded. Latency,
API token use, and monetary cost are captured for every system.

## Primary outcomes

Report counts and 95% confidence intervals for:

1. Arthur blocking precision: actionable invalid findings / all blocking
   findings;
2. Arthur recall within the exhaustively inventoried supported domains;
3. incremental yield: actionable invalid occurrences found by Arthur but missed
   by the existing compiler, tests, and linters;
4. diff-level false-block rate;
5. p50 and p95 wall-clock latency.

Also report per-domain results, all false positives and false negatives, reviewer
agreement before adjudication, and paired Arthur-versus-LLM outcomes. Confidence
intervals and bootstrap comparisons must be clustered by diff and repository;
reference occurrences from the same diff are not independent observations.

No case may be removed after prediction because it hurts a metric. Corrections
remain in an append-only audit log and require reviewer rationale.

## Fixed decision rule

Continue product development only if all of the following are true after the
preregistered cohort is complete:

1. at least 50 eligible agent-authored changes across at least five repositories;
2. at least five actionable defects found by Arthur that the existing compiler,
   tests, and linters missed;
3. Arthur blocking precision is at least 98%;
4. Arthur p95 hook latency is below three seconds;
5. at least three external developers choose to keep the gate enabled after the
   study and record that choice before seeing aggregate results.

If any condition fails, freeze checker expansion. The project may remain
available as an experimental tool, but the study does not support a claim of
proven differentiation or adoption.

## Publication rules

Publish the cohort ledger, artifact hashes, frozen predictions, anonymized
review packets, raw reviewer labels, adjudication trail, scoring code, exclusions,
and aggregate report. Report negative and inconclusive results unchanged.

The words *independent*, *real-world precision*, and *incremental value* may be
used only when this protocol is completed. Until then, Arthur's defensible claim
is narrower: on a locked mutation corpus it matched the tested Claude model's
blocking accuracy while running locally, deterministically, and without API cost.
