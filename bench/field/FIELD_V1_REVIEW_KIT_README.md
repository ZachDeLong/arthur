# Arthur field-v1 blind review — erratum 1

Thank you for reviewing 20 reference occurrences for Arthur's preregistered
field study. Please complete this independently and do not discuss labels with
the other primary reviewer.

## Blinding rules

You must not have implemented Arthur's evaluated import, environment-variable,
or Next.js route checker. Do not open Arthur or comparator prediction files,
including similarly named files in the public repository. Inspect only these
study-evidence files:

- `review-packets.jsonl` contains one detector-blind case per line.
- `standard-tool-evidence.json` contains captured compiler/test/lint output.
- `0001-workspace-package-resolution.md` is an audited, detector-blind evidence
  correction that must be applied to every import case.

The package contract embedded in the original packet used repository-root-only
lookup. Follow the correction and independently inspect the source file's
nearest applicable `package.json`, lockfile, normal Node resolution path,
captured tool output, and immutable public commit. The correction contains no
detector decisions.

Public repository links and commit hashes inside each packet may be used to
inspect additional project context. The frozen prereview snapshot is publicly
timestamped by Arthur commit `0c2f02b8fff65f95cd63ee37bcbcf3aec836ed1a`,
but do not browse its detector-prediction files.

## Labels

Fill every item in `review-template.json` with one label and a factual rationale:

- `valid`: the reference resolves correctly in the pinned project state.
- `actionable_invalid`: the reference is wrong and would reasonably be fixed
  before merge.
- `ignored`: comment, documentation string, runtime convention, or otherwise
  outside the blocking contract. Field v1's route contract covers only Next.js
  App Router routes, not routes implemented by another backend framework.
- `uncertain`: the supplied and linked evidence is insufficient.

For `actionable_invalid`, also inspect the captured standard-tool evidence and
set `caughtByStandardTools` to `true` or `false`. If true, list the exact
`standardTools[].name` values that clearly caught it. For every other label,
leave `caughtByStandardTools` as `null` and `caughtByToolNames` empty.

Replace `replace_with_your_id` with a stable pseudonym, set all three attestation
fields to `true` only if accurate, fill all 20 labels, and return the completed
JSON file. Do not add or remove case IDs.

File integrity:

- Review packets SHA-256: `0a0d5b25f7713d0d322c52bce3a44a02f1ae95c244a7554ab3253fec82402cda`
- Standard-tool evidence SHA-256: `9487e08f9611b31506cb1bf3025143c0c722004577b8262365f2714a90da5362`
- Evidence erratum SHA-256: `ff91735af822069a4e54193c57cccbb49128d6c7296e36c71e90b6acb62a2069`
- Study lock SHA-256: `4920ee235e2eb084f29b1c682860426b84052603d547d561a503b6db828a474a`
- Post-erratum audit head: `48dff97d5cd2c2b55d001cbcfbf5af883f4a0394a0ca2a9e626bd12678ea175d`
