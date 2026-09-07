# Security Policy

## Supported Versions

Security fixes are applied to the latest published Arthur release.

## Reporting A Vulnerability

Please use GitHub's private vulnerability reporting if it is enabled. Otherwise,
open a minimal issue requesting private contact without including exploit
details, credentials, private source code, or other sensitive data.

Arthur's deterministic checks run locally. The optional `codeverifier` command
sends the assembled plan and referenced project context to Anthropic using the
user's API credentials; review that context before enabling the optional
wrapper on confidential repositories. Arthur reads that credential from
`ANTHROPIC_API_KEY` and does not write new API keys to its config files.
