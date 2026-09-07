# Paired Benchmark Results

## 2026-09-07 — Arthur vs Claude Sonnet 5

- Locked cases SHA-256: `d43eefb03905aabfdf685e3af18484a5b1b484c4d1a1c59a56fd07de319e2a99`
- Locked labels SHA-256: `32fe12cef12aebece186c6f749c562fe8c17f079454b58bbf26effaefc2f0f99`
- Cases: 80 (28 import, 36 env, 16 route)
- Positive error cases: 20
- Non-error controls: 60
- Claude repetitions: 3

| System | Precision | Recall | Specificity | Exact clean/error/ignored accuracy | Wall time |
|---|---:|---:|---:|---:|---:|
| Arthur | 100% | 100% | 100% | 98.75% | 0.063 s |
| Claude Sonnet 5, run 1 | 100% | 100% | 100% | 100% | 41.85 s |
| Claude Sonnet 5, run 2 | 100% | 100% | 100% | 100% | 30.21 s |
| Claude Sonnet 5, run 3 | 100% | 100% | 100% | 100% | 42.23 s |

Arthur's only exact-outcome mismatch was `process.env.PORT`: the locked label
calls the declared variable clean, while Arthur intentionally ignores `PORT` as
a conventional runtime-provided variable. This did not affect the blocking
error/no-error result.

Claude used 17,445 input tokens and 14,479 output tokens across all three runs.
At the 2026-09-07 Claude Sonnet 5 API price of $2 per million input tokens and
$10 per million output tokens, the three repetitions cost approximately $0.18.
Arthur made no network calls.

### Honest interpretation

This corpus shows no accuracy advantage for Arthur over Claude Sonnet 5. Both
were perfect on the blocking decision. It does demonstrate Arthur's narrow
operational advantage: the same deterministic decision completed hundreds of
times faster, without an API call, cost, credential, or run-to-run variance.

The result does not establish real-world incremental value. The mutations are
single-reference cases derived from repository artifacts. The release decision
still requires blinded human adjudication of agent-authored diffs across
multiple external repositories, including whether Arthur finds actionable bugs
that compilers, tests, linters, and LLM review all miss.
