# Field Benchmark

This directory defines Arthur's release-decision benchmark. It is intentionally
separate from fixture mutations and historical repository sweeps.

The study must be committed before collection starts. After that commit, changes
to the protocol create a new version; they never rewrite an active study.

Read [`PROTOCOL.md`](PROTOCOL.md) for the complete design and
[`study-plan.json`](study-plan.json) for the machine-readable stopping and
decision rules.

Version 1 was activated by public commit
[`2d914e5`](https://github.com/ZachDeLong/arthur/commit/2d914e5e41637726dbb440dda4aed47ea148febb).
`activation.json` binds every capture to the exact checker source and dependency
lock from that commit. The collector refuses to run if those inputs change.

## Workflow

Keep raw study data under `bench/results/` (gitignored) or another private
directory until it has been reviewed for publication. Capture only committed,
clean result states.

```bash
# 1. Start the preregistered study
npm run bench:field -- init \
  --study bench/results/field-v1 \
  --id field-v1

# 2. Add each consecutive eligible change before looking at Arthur's output
npm run bench:field -- capture \
  --study bench/results/field-v1 \
  --project /path/to/project \
  --base HEAD~1 \
  --repository public-or-anonymized-repo-id \
  --developer anonymized-developer-id \
  --agent Codex \
  --agent-evidence "Task record ID or other authorship evidence" \
  --tool "compiler:typecheck=npm run check" \
  --tool "test:unit=npm test" \
  --tool "lint:lint=npm run lint"

# Record every allowed exclusion instead of silently dropping it
npm run bench:field -- exclude \
  --study bench/results/field-v1 \
  --repository repo-id \
  --reason not_agent_authored \
  --note "Human-written maintenance commit"

# 3. After 50 changes / 5 repositories, freeze the fixed LLM comparison
# Set ARTHUR_BENCH_MODEL to an immutable provider model/version ID, not a
# rolling "latest" alias. The requested and provider-reported IDs are saved.
npm run bench:field -- comparator \
  --study bench/results/field-v1 \
  --input-usd-per-million "$INPUT_RATE_USD_PER_MILLION" \
  --output-usd-per-million "$OUTPUT_RATE_USD_PER_MILLION" \
  --pricing-source "Provider pricing source and access date"
npm run bench:field -- freeze --study bench/results/field-v1

# 4. Give frozen/review-packets.jsonl and frozen/standard-tool-evidence.json
# (but no detector files) to two reviewers
npm run bench:field -- review-template --study bench/results/field-v1 --reviewer r1 --out r1.json
npm run bench:field -- submit-review --study bench/results/field-v1 --file r1.json
# Repeat for r2. Each reviewer also records whether the captured standard tools
# explicitly caught every case they label actionable-invalid; then use
# adjudication-template / submit-adjudication for either kind of disagreement.

# 5. Group confirmed occurrences into defects, record retention, and score
npm run bench:field -- baseline-template --study bench/results/field-v1 --assessor a1 --out baseline.json
npm run bench:field -- submit-baseline --study bench/results/field-v1 --file baseline.json
npm run bench:field -- retention --study bench/results/field-v1 --developer d1 --keep yes
npm run bench:field -- score --study bench/results/field-v1
```

Run `npm run bench:field -- --help` for every command. Comparator batches are
checkpointed, so an interrupted API run resumes without paying for completed
batches again. Record the provider's published rates at collection close; those
rates, token counts, source, and calculated cost are frozen with the run. API
keys are read from the environment and are never written.

## Captured evidence

Each change records immutable commits, a SHA-256 hash of the original diff, a
secret-redacted stored diff, changed source snapshots, an exhaustive inventory
of supported references, ground-truth contract facts, Arthur predictions,
standard compiler/test/lint output, timing, and artifact hashes. Review packets
contain no Arthur or LLM decision. They contain the standard-tool commands, and
the separately frozen evidence file stores each redacted output once per change,
so both independent reviewers can make the preregistered baseline attribution
without ballooning every case packet. A blinded post-review assessor can group
duplicate occurrences into defects but cannot change those tool decisions.

Before Arthur runs, the collector writes and audits an immutable selection
record containing the commits, authorship evidence, diff hash, independent case
inventory hash, and existing-tool commands. If prediction or capture is
interrupted, that selection remains pending and the cohort cannot close until it
is completed; an unfavorable prediction therefore cannot be silently dropped.

The inventory does not call Arthur's reference extractors. It uses a separate
TypeScript traversal plus a broader lexical pass, deliberately retaining
comment/string lookalikes for reviewers to label as ignored controls. Any
blocking Arthur finding that cannot be paired with that independent inventory
prevents the study from freezing.

Before the first LLM request, a collection lock commits the entire cohort and
closes capture permanently. Arthur latency is measured by spawning the compiled
CLI a developer actually waits for; its findings are cross-checked against the
in-process frozen checker and the compiled build hash must remain identical for
the full cohort.

Secret-shaped tokens and non-example `.env` values are redacted from stored
artifacts. This is defense in depth, not a publication guarantee: inspect private
or proprietary study bundles before making them public.

Every material event is appended to `audit.jsonl` as a hash chain. `status`
prints its current head hash. Publish or independently timestamp that small
receipt throughout collection; a purely local hash chain detects accidental
rewrites but cannot prove that a determined study operator did not replace the
entire history before publication.

No field result may be described as independent until the anonymized labels and
adjudication records have been completed by reviewers who did not implement the
Arthur checker being evaluated.
