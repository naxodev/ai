---
status: done
---

# Phase 1 package — review and commit only the existing Prettier policy edit

## Intent

Review the already-present root `.prettierignore` edit and make no new product or policy change. The approved edit preserves the original four entries and adds exactly one final `.apnea/` line so root Prettier ignores Apnea runtime records.

This phase exists only to validate and separately commit that existing one-line policy edit. The coder does not commit. After code review approval and a successful fresh-shell verify gate, the orchestrator must isolate only this reviewed path in the prescribed `jj squash` workflow. The existing OpenCode/Pi package-smoke corrections remain dirty and unchanged for Phase 2.

Apnea updates its own task, artifact, state, backup, and verify-log records while the workflow advances. Do not manually edit, format, restore, delete, rename, or hash those records. In particular, do not edit `.apnea/state.json`.

## Reviewed path

- `.prettierignore` — inspect the existing edit; do not rewrite it when it already has the exact approved content.

The expected complete file is exactly five newline-terminated lines:

```text
bun.lock
node_modules/
.nx/
**/dist/
.apnea/
```

## Files to touch

No product, policy, configuration, documentation, package, or lockfile should be edited by the coder in this phase.

The coder writes only the exact coder-result artifact required by its later dispatcher task. That required workflow output is not permission to alter any existing `.apnea` record.

## Files not to touch

Do not edit or normalize:

- `.prettierignore` itself, unless an exact validation unexpectedly proves it differs; in that case stop and report the mismatch rather than repairing it.
- Any file under `.apnea/`, especially `.apnea/state.json`, existing tasks, artifacts, backups, or logs.
- `packages/opencode-music-player/scripts/package-smoke.ts`.
- `packages/pi-music-dock/scripts/package-smoke.ts`.
- `.prettierrc.json`, `package.json`, `bun.lock`, or any `project.json`.
- `docs/music-session-architecture.html` or any other documentation.
- Any product source, test, manifest, verified ancestor, or unrelated dirty path.

Do not create temporary evidence files in the repository or outside it. Do not use shell functions, environment variables, or content hashes/snapshots of `.apnea`.

## Exact steps

### 1. Confirm the current worktree without mutating it

From the repository root, run:

```sh
jj status
jj diff --summary
jj diff -- .prettierignore
```

Inspect the output rather than cleaning it. The worktree is expected to contain dispatcher-managed `.apnea` changes, the existing `.prettierignore` edit, and both existing package-smoke corrections. The `.prettierignore` diff must show only one added final line:

```diff
+.apnea/
```

If the diff shows any other `.prettierignore` change, stop and report it. Do not restore from a backup, reset the worktree, or edit another file.

### 2. Compare the complete policy file to an inline static value

Run this command exactly:

```sh
printf '%s\n' 'bun.lock' 'node_modules/' '.nx/' '**/dist/' '.apnea/' | cmp - .prettierignore
```

It constructs the expected bytes inline and compares them directly, including the final newline. It must be silent and exit zero. Do not replace it with a temporary file prepared in an earlier shell.

### 3. Prove there is exactly one `.apnea/` entry

```sh
test "$(grep -cFx '.apnea/' .prettierignore)" -eq 1
```

This must exit zero. The exact-file comparison from Step 2 separately proves the entry is final and that all four original lines are unchanged.

### 4. Prove Prettier ignores current Apnea state

Run the read-only file-information check:

```sh
bunx prettier --file-info .apnea/state.json | grep -q '"ignored": true'
```

It must exit zero. Do not run Prettier in write mode and do not inspect correctness by changing `.apnea/state.json`.

### 5. Run only the phase's read-only formatting gate

```sh
bun run format:check
```

The command must exit zero. It must rely on the approved ignore entry rather than formatting Apnea records. Do not run `bun run format`, `prettier --write`, or the full `bun run check`; the unchanged complete gate belongs to Phase 2.

### 6. Check the accumulated diff for whitespace errors

```sh
git diff --check
```

It must exit zero. This is a read-only check; do not stage or commit with Git.

### 7. Record the result without changing scope

Run `jj status`, `jj diff --summary`, and `jj diff -- .prettierignore` again for the coder-result transcript. Confirm that:

- `.prettierignore` still has only the approved one-line diff.
- Both package-smoke corrections remain present and unchanged for Phase 2.
- Existing and dispatcher-created `.apnea` records remain preserved rather than cleaned or normalized.
- No coder-owned product edit was introduced.

Write the required coder-result artifact with the five verify commands, exit statuses, concise output tails, and any mismatch. Do not run `git commit`, `jj describe`, `jj commit`, `jj squash`, `jj split`, reset, clean, restore, abandon, rebase, push, or open a PR. The orchestrator alone performs the approved phase commit and must keep the package-smoke corrections out of this phase commit.

## Acceptance checks

Phase 1 is complete only when all of the following hold:

- `.prettierignore` is byte-for-byte the expected five-line file with a final newline.
- Its diff adds exactly one final `.apnea/` line and changes nothing else.
- Exactly one line equals `.apnea/`.
- `bunx prettier --file-info .apnea/state.json` reports `"ignored": true`.
- `bun run format:check` passes without any write-mode formatter.
- `git diff --check` passes.
- The coder makes no product/policy edit and does not manually alter any `.apnea` record.
- The current OpenCode/Pi package-smoke corrections, `docs/music-session-architecture.html`, verified commits through `ae742b68`, and unrelated dirty work remain preserved.
- After approval, the phase commit contains only `.prettierignore` among repository product/policy paths; the package-smoke corrections remain for Phase 2.
- No Git commit, coder/reviewer Jujutsu mutation, push, publication, release, PR operation, or manual `.apnea/state.json` edit occurs.

## Verify commands

These are deliberately five independent, self-contained commands. `apnea commit` may execute each in a fresh `bash -lc` shell, so none relies on temporary state, a prior command's environment, a shell function, or an `.apnea` hash:

```sh
printf '%s\n' 'bun.lock' 'node_modules/' '.nx/' '**/dist/' '.apnea/' | cmp - .prettierignore
test "$(grep -cFx '.apnea/' .prettierignore)" -eq 1
bunx prettier --file-info .apnea/state.json | grep -q '"ignored": true'
bun run format:check
git diff --check
```

## Dependencies

- Approved full plan at `.apnea/artifacts/plan.md`.
- The already-present approved `.prettierignore` edit.
- Root Prettier `3.9.6` and the existing `format:check` script.
- The current dirty Jujutsu worktree and orchestrator support for isolating only the reviewed phase path while preserving other dirty work on top.

## Non-goals

- Editing `.prettierignore`, adding another ignore rule, or changing root formatting configuration.
- Creating temporary baselines, functions, environment state, or hashes to compare mutable Apnea records.
- Formatting, repairing, restoring, deleting, or otherwise modifying `.apnea` state/history.
- Running or fixing the complete `bun run check`; reviewing/editing/committing either package-smoke script; changing Effect code; or performing mixed-host verification.
- Broad formatting, dependency or pin changes, refactoring, documentation edits, cleanup of unrelated work, or rewriting verified commits.
- Coder/reviewer commits or Jujutsu history mutation, Git mutation commands, pushing, publishing, releasing, or creating/updating a PR.
