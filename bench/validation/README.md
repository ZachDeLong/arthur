# Validation Corpus

`corpus.json` contains manually specified source snippets and expected outcomes
for Arthur's blocking diff-mode rules. The labels are stored independently of
checker output, but they have not been independently audited. The corpus covers
both single-package fixtures and sibling workspaces so root-only resolution and
cross-workspace leakage fail the release gate. Run the gate with:

```bash
npm run validate
```

The gate currently requires at least 98% error precision, 95% recall, exact
outcome agreement for every checked fixture, and p95 execution below three
seconds per case.

This corpus is regression evidence, not a real-world product claim. It does not
replace evaluation on external repositories, real agent-authored changes, or
continued measurement of findings that existing compilers and tests miss.

Supplemental repository sweeps are recorded separately in
[`FIELD_RESULTS.md`](FIELD_RESULTS.md) so unlabeled history is never mixed into
the fixture precision and recall metrics.
