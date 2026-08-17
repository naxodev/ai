---
status: done
verdict: CHANGES_REQUIRED
---

## Findings

### High — Product-tree preservation is not verified across the repository

The acceptance criteria require that no product code, tests, documentation, manifests, lockfiles, configuration, or other non-Apnea repository content changes after `eec2b96b`. However, the only equality check against that revision is restricted to `.prettierignore`, `README.md`, `bun.lock`, `docs`, and `packages`. A changed or newly added product file anywhere else would pass that check. `git diff --check` does not close the gap: it checks diff formatting, not that the diff is empty.

Add an independent, self-contained one-line verification that compares the complete `eec2b96b..@` repository tree and rejects every changed path except orchestrator-managed `.apnea/**` content and the conditionally permitted `pr-description.md`. This is required for the phase's product-tree-preservation acceptance claim.
