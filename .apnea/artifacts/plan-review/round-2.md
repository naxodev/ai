---
status: done
verdict: CHANGES_REQUIRED
---

## Findings

### High — Product-tree preservation remains under-verified

The plan still checks `eec2b96b..@` only for `.prettierignore`, `README.md`, `bun.lock`, `docs`, and `packages`. Changes or additions at any other product path would therefore pass despite the acceptance criterion and definition of done requiring the complete product tree to remain unchanged. `git diff --check` only detects malformed whitespace; it does not require an empty diff.

Add an independent, self-contained one-line command that checks the complete repository diff from `eec2b96b` to `@`, permitting only orchestrator-managed `.apnea/**` paths and the conditionally editable `pr-description.md`. The current scoped equality command may remain as an implementation-baseline guard, but it cannot establish repository-wide preservation.
