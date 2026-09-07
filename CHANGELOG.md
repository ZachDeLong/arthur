# Changelog

## 0.6.0 - Unreleased

### Added

- Changed-line source checking for environment variables and Next.js routes.
- File, line, and column locations in JSON findings.
- SARIF 2.1.0 output for code-scanning integrations.
- Safe, idempotent pre-commit hook installation.
- Manually labelled validation corpus and precision/performance regression gate.
- Separate historical field-validation record for real repository diffs.
- CI coverage for supported Node.js LTS releases on Windows and Linux.

### Changed

- Staged checks now read the Git index rather than unstaged working-tree data.
- Working-tree checks include untracked source files by default.
- Source checkers ignore unchanged references, comments, and documentation strings.
- Source env checks discover custom `.env.*` variants and support destructured
  and Bun env access; route checks infer fetch's default GET method.
- Strict mode enforces coverage without enabling experimental rules.
- Declared but unavailable packages are warnings instead of verified imports.
- TypeScript now ships as a runtime dependency for deterministic `.d.ts` parsing.
- Repository indexing no longer silently stops at six directory levels.
- JSON report schema is now 1.1 and distinguishes errors from warnings.
- The default MCP surface is reduced to `check_all` and `check_diff`; legacy,
  networked LLM, and session tools are explicit opt-ins.
- The optional LLM wrapper now defaults to `claude-sonnet-5` and reads API keys
  only from the environment.

### Fixed

- Diff import checks now resolve dependencies from each importing file's
  workspace instead of assuming every project has a root `package.json` and
  root `node_modules`.
- Import validation caches are isolated by resolution directory, so the same
  package name can correctly pass in one workspace and fail in another.
- Future field-study package contracts are tied to each blinded occurrence's
  workspace rather than reusing root-only dependency facts.
- SQL plan extraction no longer treats arbitrary TypeScript code blocks as SQL.
- Route method findings now use the correct HTTP-method category.
- Route handler indexing ignores commented exports and handles aliased exports.
- Staged checks work before a repository's first commit.
