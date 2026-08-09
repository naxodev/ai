# Security Policy

## Supported versions

Only the latest published version receives security fixes.

## Reporting a vulnerability

Do not open a public issue. Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/naxodev/ai/security/advisories/new).

Include affected versions, impact, reproduction steps, and any suggested mitigation. You should receive an acknowledgement within seven days. We will coordinate disclosure after a fix is available.

These packages invoke documented local commands with the current user's permissions. Apnea also sends repository-controlled text to configured agent CLIs and executes planner-authored verification commands. See [`packages/apnea/SECURITY.md`](packages/apnea/SECURITY.md) for that trust model.
