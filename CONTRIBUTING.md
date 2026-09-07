# Contributing

Arthur optimizes for precise repository-reference checks. New rules should
prefer a narrow, deterministic source of truth over broad pattern matching.

## Development

Requires Node.js 22 or newer.

```bash
npm ci
npm run check
npm test
npm run validate
npm run build
```

Every source-mode rule should include tests for valid references, invalid
references, unchanged lines, comments, documentation strings, and source
locations. Blocking rules should meet the validation threshold documented in
`bench/validation/README.md`.

Please keep experimental or recall-oriented rules opt-in until they have
independently labelled precision evidence.
