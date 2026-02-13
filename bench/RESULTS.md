# Arthur Benchmark Results

> Generated 2026-02-13 from 12 benchmark run(s), 22 prompt evaluation(s)

## Path Hallucination Detection

Plans generated with README-only context (no file tree), then verified against the real project structure.

| Prompt | Fixture | Extracted | Hallucinated | Rate | Static Detection | LLM Detection |
|--------|---------|-----------|-------------|------|-----------------|---------------|
| 06 | fixture-c | 5 | 5 | 100.0% | 5/5 (100%) | 0/5 (0.0%) |
| 06 | fixture-c | 7 | 3 | 75.0% | 3/3 (100%) | 0/3 (0.0%) |
| 06 | fixture-c | 7 | 6 | 85.7% | 6/6 (100%) | 0/6 (0.0%) |
| 07 | fixture-c | 3 | 2 | 66.7% | 2/2 (100%) | 2/2 (100.0%) |
| 08 | fixture-c | 10 | 5 | 55.6% | 5/5 (100%) | 0/5 (0.0%) |
| 06 | fixture-c | 7 | 3 | 75.0% | 3/3 (100%) | 0/3 (0.0%) |
| 07 | fixture-c | 4 | 3 | 75.0% | 3/3 (100%) | 2/3 (66.7%) |
| 08 | fixture-c | 5 | 3 | 75.0% | 3/3 (100%) | 1/3 (33.3%) |
| **Avg** | | | | **27.6%** | **100%** | **9.1%** |

**Key finding:** Static path checking achieves 100% detection with zero variance. LLM detection is unreliable — it sees the full file tree in context but still misses hallucinated paths.

## Schema Hallucination Detection

Fixture uses adversarial Prisma naming (`Participant` not `User`, `displayIdentifier` not `username`, `participantEngagement` not `engagement`). Plans generated with README-only context — no schema file provided.

| Prompt | Task | Schema Refs | Hallucinated | Rate | Static Detection | LLM Detection |
|--------|------|------------|-------------|------|-----------------|---------------|
| 06 | Add an analytics dashboard at /analytics | 10 | 3 | 30.0% | 3/3 (100%) | 1/3 (33.3%) |
| 06 | Add an analytics dashboard at /analytics | 10 | 2 | 20.0% | 2/2 (100%) | 1/2 (50.0%) |
| 06 | Add an analytics dashboard at /analytics | 9 | 3 | 33.3% | 3/3 (100%) | 1/3 (33.3%) |
| 07 | Build a content recommendation engine: f | 16 | 5 | 31.3% | 5/5 (100%) | 4/5 (80.0%) |
| 08 | Add a CSV export feature to the content  | 6 | 1 | 16.7% | 1/1 (100%) | 1/1 (100.0%) |
| 06 | Add an analytics dashboard at /analytics | 11 | 3 | 27.3% | 3/3 (100%) | 3/3 (100.0%) |
| 07 | Build a content recommendation engine: f | 18 | 4 | 22.2% | 4/4 (100%) | 3/4 (75.0%) |
| 08 | Add a CSV export feature to the content  | 7 | 1 | 14.3% | 1/1 (100%) | 1/1 (100.0%) |
| **Avg** | | | | **24.4%** | **100%** | **71.5%** |

### Per-Category Breakdown

| Category | Total Refs | Hallucinated | Rate |
|----------|-----------|-------------|------|
| Models | 21 | 7 | 33.3% |
| Fields | 45 | 15 | 33.3% |
| Methods | 20 | 0 | 0.0% |
| Relations | 1 | 0 | 0.0% |

### Recurring Hallucinations

- `prisma.engagement` — appeared in 7/8 runs
- `displayName` — appeared in 6/8 runs
- `category` — appeared in 3/8 runs
- `contentItems` — appeared in 2/8 runs
- `visible` — appeared in 2/8 runs

**Key finding:** Static schema checking achieves 100% detection. LLMs pattern-match from task descriptions rather than reading the actual schema, producing systematic hallucinations.

## Intent Drift Detection

Synthetic drift injected into generated plans (scope creep, feature drift, wrong abstraction, etc.). Measures whether the verifier catches the injected drift.

**Overall detection rate: 85.2%**

| Category | Detection Rate |
|----------|---------------|
| scope-creep | 85.7% |
| feature-drift | 60.0% |
| wrong-abstraction | 100.0% |
| missing-requirement | 100.0% |
| tech-mismatch | 100.0% |
| wrong-problem | 100.0% |

### Per-Spec Details

| Spec ID | Category | Injected | Detected | Method |
|---------|----------|----------|----------|--------|
| 01-scope-creep | scope-creep | yes | no | — |
| 01-feature-drift | feature-drift | yes | yes | critical-callout |
| 01-scope-creep | scope-creep | yes | yes | critical-callout |
| 01-feature-drift | feature-drift | yes | no | — |
| 02-scope-creep | scope-creep | yes | yes | critical-callout |
| 02-wrong-abstraction | wrong-abstraction | yes | yes | critical-callout |
| 03-scope-creep | scope-creep | yes | yes | critical-callout |
| 03-missing-requirement | missing-requirement | yes | yes | critical-callout |
| 04-scope-creep | scope-creep | yes | yes | critical-callout |
| 04-tech-mismatch | tech-mismatch | yes | yes | signal-match |
| 05-scope-creep | scope-creep | yes | yes | critical-callout |
| 05-wrong-problem | wrong-problem | yes | yes | signal-match |
| 01-scope-creep | scope-creep | yes | yes | critical-callout |
| 01-feature-drift | feature-drift | yes | no | — |
| 01-scope-creep | scope-creep | yes | yes | critical-callout |
| 01-feature-drift | feature-drift | skipped | no | — |
| 01-scope-creep | scope-creep | yes | yes | critical-callout |
| 01-feature-drift | feature-drift | yes | yes | signal-match |
| 01-scope-creep | scope-creep | yes | yes | critical-callout |
| 01-feature-drift | feature-drift | yes | yes | signal-match |
| 02-scope-creep | scope-creep | yes | yes | critical-callout |
| 02-wrong-abstraction | wrong-abstraction | yes | yes | critical-callout |
| 03-scope-creep | scope-creep | yes | yes | critical-callout |
| 03-missing-requirement | missing-requirement | yes | yes | critical-callout |
| 04-scope-creep | scope-creep | yes | no | — |
| 04-tech-mismatch | tech-mismatch | yes | yes | critical-callout |
| 05-scope-creep | scope-creep | yes | yes | critical-callout |
| 05-wrong-problem | wrong-problem | yes | yes | critical-callout |

## API Usage

- Total input tokens: 189,212
- Total output tokens: 161,270
- Total API calls: 71
- Benchmark runs: 12

## Methodology

### Plan Generation
Plans are generated by an LLM with README-only context — the model has no access to the actual file tree or source code. This creates a realistic scenario where the model must guess at file paths and schema details.

### Verification
Each plan is verified through two independent channels:
1. **Static analysis** — Deterministic checks against ground truth (file tree, Prisma schema). Zero LLM involvement.
2. **LLM verifier** — Independent Claude instance reviews the plan with full project context. Uses the same adversarial prompt across all runs.

### Detection Parsing
LLM verifier output is parsed using multi-tier detection:
- **Paths:** direct match → sentiment analysis → section detection → directory correction
- **Schema:** direct match → sentiment analysis → section detection
- **Drift:** critical callout → alignment section → signal match (≥40% threshold)
