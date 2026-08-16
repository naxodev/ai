---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 5 package remains aligned with approved Plan Phase 5. It permits narrowly evidenced fixes to owning migration files and environment repair outside the repository, but explicitly prohibits workspace-wide formatting of unrelated content and requires dispatcher/pre-existing `.apnea` changes to be preserved.

## Findings

### High — Hundreds of unrelated `.apnea` files were reformatted inside the phase child

The coder result declares only the two smoke scripts as repository files touched, but the diff from approved parent `ae742b68` contains hundreds of modified `.apnea` task/artifact files. For example, `.apnea/tasks/code_review-p1-r1-1786455897050.md` was changed solely from `1)` list markers to Prettier's `1.` form. This is the exact dispatcher/pre-existing backlog that blocked Rounds 1–3, and normalizing it in the current phase child violates the package's prohibition on workspace-wide writes and its requirement to preserve unrelated changes.

The now-green gate does not make that undisclosed scope expansion acceptable. The `.apnea` normalization must be attributed and handled outside the Phase 5 change/baseline (without editing `.apnea/state.json` here), after which the phase must demonstrate the unchanged full gate from a worktree whose phase-owned repository diff is limited to evidence-backed corrections. Do not discard unrelated content merely to repair this finding.

## Verification

The two migration-owned script corrections are narrow and sound: they make synchronous diagnostics tolerant of absent output and keep Pi stream validation inside the existing exact-process cleanup path. Their uncached typechecks and focused smokes passed. The final `bun run check` also passed root format/policy and all 31 selected Nx tasks, including packed-core, exact OpenCode, and exact Pi smoke evidence; `git diff --check` passed and no generated debris was found. Approval is blocked solely by the undeclared out-of-scope `.apnea` rewrites in the phase diff.
