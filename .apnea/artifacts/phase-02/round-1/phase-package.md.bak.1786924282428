---
status: done
---

# Phase 2 package — retain package-smoke corrections and pass the unchanged full gate

## Intent

Run the repository's existing complete `bun run check` without changing the root command or omitting any target. Retain the narrow OpenCode and Pi package-smoke corrections already present in the current parent:

- OpenCode synchronous process diagnostics tolerate absent `stdout`/`stderr`.
- Pi synchronous process diagnostics tolerate absent `stdout`/`stderr`.
- Pi validates that the RPC child supplied piped stdin/stdout/stderr before consuming them, while keeping validation failure inside the existing exact process-group termination and cleanup path.

At this phase dispatch, those corrections no longer appear as a working-copy diff because they are present in the approved parent together with the Phase 1 policy result. Do not mistake their absence from `jj status` for removal, and do not rewrite the approved parent to move them. This phase verifies the retained behavior. No new product edit is expected.

If a check fails, diagnose the exact stage and owning file before editing. Make only the smallest evidence-backed correction, rerun the exact focused owner target uncached, and then rerun the literal complete root gate. Any Effect change must use only the repository-pinned Effect v4 (`4.0.0-beta.101`).

Use the configured Pi role profile in a regular pane. The coder and reviewer do not commit or mutate Jujutsu history. After approval, the orchestrator handles the prescribed `jj squash` workflow. Do not push or open a PR.

## Files to touch

No product file is expected to change.

Only if a reproducible failure directly demonstrates a defect in one of these existing owners may the coder make a narrow correction:

- `packages/opencode-music-player/scripts/package-smoke.ts`
- `packages/pi-music-dock/scripts/package-smoke.ts`

A different existing file may be touched only when output from the unchanged gate and an uncached focused rerun directly prove that file owns a migration regression. Record that evidence before editing.

The coder writes only the exact coder-result artifact supplied by its dispatcher task. That required workflow output is not permission to manually alter existing Apnea records.

## Files not to touch

Do not edit, restore, normalize, delete, or regenerate:

- `.apnea/**`, especially `.apnea/state.json`, existing tasks, artifacts, backups, and verify logs.
- `.prettierignore`; the approved final `.apnea/` entry is Phase 1 baseline.
- `package.json`, `nx.json`, any `project.json`, or scripts to skip/alter gate stages.
- `bun.lock`, dependency versions, exact OpenCode/Pi pins, Pi peer ranges, exports, package file lists, or publish metadata.
- `docs/music-session-architecture.html` or any other documentation.
- Passing tests, fixtures, snapshots, or package assertions merely to weaken acceptance.
- Verified commits through `ae742b68`, the approved parent, or unrelated dirty work.

Do not run a workspace-wide formatter in write mode. Do not manually edit any `.apnea` file. Do not use Git mutation commands, reset, clean, restore, abandon, rebase, `jj describe`, `jj commit`, `jj squash`, or `jj split`.

## Exact steps

### 1. Inspect and preserve the current baseline

From the repository root, run read-only inspections:

```sh
jj status
jj diff --summary
jj log -r 'ancestors(@, 5)' --no-graph -T 'commit_id.short() ++ " " ++ description.first_line() ++ "\n"'
```

Expected baseline:

- The current parent is the approved `chore(format): exclude Apnea runtime records` phase result.
- The current working copy has no product diff; dispatcher-owned `.apnea` activity is expected.
- `docs/music-session-architecture.html` and verified migration history remain present.

Do not clean the worktree. If an unexplained product diff is present, identify and report it before running any writer.

### 2. Review the retained package-smoke behavior

Read both scripts and confirm the intended corrections are still present:

1. In `packages/opencode-music-player/scripts/package-smoke.ts`, the synchronous `output` helper safely renders missing `stdout` and `stderr` as empty strings.
2. In `packages/pi-music-dock/scripts/package-smoke.ts`, the same synchronous diagnostic behavior is retained.
3. The Pi RPC launch checks stdin/stdout/stderr are real piped streams before capture or writes.
4. That Pi check remains inside the existing `try` whose failure path terminates the exact detached process group, captures available diagnostics, confirms owned music-core processes are absent, and removes the temporary root only after cleanup succeeds.
5. OpenCode remains manifest-pinned to `0.0.0-next-17386`; Pi remains manifest-pinned to `0.84.0` with its existing supported peer ranges. Neither smoke falls back to an arbitrary global host.

This is review only. Do not edit either script when the behavior is already correct.

### 3. Run focused uncached typechecks

```sh
bunx nx run opencode-music-player:typecheck --skip-nx-cache
bunx nx run pi-music-dock:typecheck --skip-nx-cache
```

Both must exit zero. A type failure must be traced to its exact diagnostic before any edit. Do not suppress the error with assertions that weaken stream validation or by changing TypeScript configuration.

### 4. Run focused uncached package smokes

```sh
bunx nx run opencode-music-player:smoke --skip-nx-cache
bunx nx run pi-music-dock:smoke --skip-nx-cache
```

Require the output to demonstrate:

- OpenCode installed and launched exact `0.0.0-next-17386`, resolved packed OpenCode/music-core paths inside the isolated install, rendered the real host slots, and cleaned its exact tmux server/root.
- Pi installed and launched exact `0.84.0`, resolved packed dock/music-core paths inside the isolated install, returned all three extension commands over RPC, exited status zero, left no owned core process, and cleaned its temporary root.

If a smoke cannot confirm child/process-group termination, preserve and report its external temporary root until termination is independently confirmed. Do not delete beneath a possibly live process and do not weaken cleanup assertions.

### 5. Run the unchanged complete repository gate

From the repository root, run exactly:

```sh
bun run check
```

Do not substitute a reduced project list. As declared in root `package.json`, this must run:

1. root `format:check`;
2. root `policy:check`;
3. Nx `run-many` for every defined `typecheck`, `test`, `parity`, `format:check`, `package:check`, and `smoke` target.

A valid Nx cache hit is acceptable under the repository's configured cache policy; the two corrected package targets were already exercised uncached in Steps 3 and 4. Preserve enough output in the coder result to show root format/policy success, the Nx target summary, packed music-core Node lifecycle evidence, exact OpenCode evidence, exact Pi evidence, and unrelated package smoke success.

### 6. Diagnose narrowly if any command fails

Do not edit immediately. First:

1. Identify the first failed root stage or exact `project:target`.
2. Rerun that existing command or target with diagnostics. For Nx, use the exact `project:target` with `--skip-nx-cache`.
3. Classify the cause as environment/tooling, formatting/policy, type/test/parity, package/smoke, or generated debris.
4. For an environment mismatch, repair the external environment when repository code is correct. Do not change a manifest or pin to match an arbitrary local/global executable.
5. For a repository regression, edit only the minimum existing owner. If formatting alone fails, run Prettier only on the specifically reported owned file; never use root `bun run format` or format `.apnea`.
6. If Effect code is unavoidably involved, use Effect v4 only and preserve existing Layer/scope, Schema/Config, bounded concurrency, and supervised cleanup ownership.
7. Rerun the exact failing owner target uncached.
8. Rerun all final verify commands, including the literal `bun run check`. A focused pass never substitutes for the final complete gate.

If the failure is unrelated/pre-existing and cannot be repaired within this narrow migration scope, report it as a blocker rather than expanding scope.

### 7. Check whitespace and repository hygiene

After the successful full gate, run:

```sh
git diff --check
test -z "$(find packages -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.bind-lock*' -o -name '*.log' -o -name '*.tmp' \) -print -quit)"
jj diff --summary
jj status
```

`git diff --check` and the debris check must exit zero. Inspect Jujutsu output for only expected dispatcher activity and any explicitly evidenced correction. Do not remove declared ignored build output or dispatcher-created records merely to make status shorter.

### 8. Report without claiming later evidence

The coder result must include:

- Each final verify command, exit status, and a concise output tail.
- Root format/policy and Nx completion summary from `bun run check`.
- Exact packed-core Node, OpenCode, and Pi smoke evidence.
- Any failed attempt, diagnosis, edited owner, and focused uncached rerun.
- Final hygiene/status observations and any retained external temporary root.

Do not claim that automated mixed-host tests or separate package smokes satisfy Phase 3's real regular-pane OpenCode/Pi session.

## Acceptance checks

Phase 2 is complete only when all of the following hold:

- The OpenCode and Pi nullable synchronous-output corrections remain intact.
- Pi's piped-stream validation remains inside the exact termination/cleanup boundary and does not weaken RPC lifecycle checks.
- Uncached OpenCode and Pi typechecks pass.
- Uncached exact OpenCode `0.0.0-next-17386` and exact Pi `0.84.0` package smokes pass with isolated packed resolution and confirmed cleanup.
- The literal unchanged `bun run check` exits zero after running root format/policy and all selected Nx typecheck, test, parity, format, package, and smoke targets.
- The complete gate includes successful packed music-core Node daemon/client lifecycle, exact OpenCode, exact Pi, and unrelated package smoke evidence.
- Any new correction is minimal, directly owned by a demonstrated failure, passes its exact uncached focused target, and is followed by a successful final full gate.
- Any Effect edit uses only repository-pinned Effect v4.
- `git diff --check` passes and no owned archive/socket/marker/log/temp debris remains under `packages`.
- `.prettierignore`, all Apnea records, architecture documentation, package pins/ranges, verified history, the approved parent, and unrelated work remain preserved.
- No real mixed-host claim, release, publication, push, PR creation, Git commit, coder/reviewer Jujutsu mutation, or manual `.apnea/state.json` edit occurs.

## Verify commands

Run these commands from the repository root. They are independent and runnable by the commit gate:

```sh
bunx nx run opencode-music-player:typecheck --skip-nx-cache
bunx nx run pi-music-dock:typecheck --skip-nx-cache
bunx nx run opencode-music-player:smoke --skip-nx-cache
bunx nx run pi-music-dock:smoke --skip-nx-cache
bun run check
git diff --check
test -z "$(find packages -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.bind-lock*' -o -name '*.log' -o -name '*.tmp' \) -print -quit)"
```

## Dependencies

- Approved full plan at `.apnea/artifacts/plan.md`.
- Approved Phase 1 parent with root `.apnea/` Prettier exclusion.
- Retained OpenCode/Pi package-smoke corrections in the current parent.
- Verified music-session migration commits through `ae742b68`.
- Existing Bun, Node, npm, Nx, tmux, macOS, and registry access required by repository targets.

## Non-goals

- Reworking Phase 1 history or moving retained corrections between verified commits.
- New product behavior, protocol/lifecycle redesign, acceptance expansion, broad refactoring, or workspace-wide formatting.
- Dependency/lockfile updates, host pin or peer-range changes, manifest/export/package-list changes, test weakening, or cache-policy changes.
- Editing/normalizing `.apnea`, architecture documentation, unrelated files, verified commits, or root gate definitions.
- Real mixed OpenCode/Pi interactive certification; that is Phase 3.
- Commits or Jujutsu mutations by coder/reviewer, Git mutation commands, reset/clean/abandon, push, publication, release, or creating/updating a PR.
