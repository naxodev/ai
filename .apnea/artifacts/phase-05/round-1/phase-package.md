---
status: done
---

# Phase 5 package — run the full repository gate

## Intent

Run the repository's existing top-level `bun run check` exactly as declared. This is the accumulated automated release gate for the verified music-session migration, exact-pinned package smokes, documentation, and all unrelated workspace projects.

No product edit is expected. If the gate passes, record the evidence and make no source change. If it fails, diagnose the exact target, make only the smallest correction owned by that failure, rerun the focused target, and then rerun the complete top-level gate.

This phase does not perform the later interactive mixed OpenCode/Pi verification and does not add new acceptance, scripts, tests, or release behavior.

## Exact steps

### 1. Preserve and record the approved baseline

1. Run `jj status` and `jj diff --summary` before the gate.
2. Preserve approved documentation commit `ae742b68`, exact Pi commit `dee247d7`, exact OpenCode commit `6613d6d1`, packed-core commit `863c6e7b`, every earlier verified commit, `.apnea/state.json`, `docs/music-session-architecture.html`, and all unrelated changes.
3. Confirm the current phase child has no unexpected product diff before testing. Do not reset, clean, restore, abandon, rebase, or rewrite the approved parent chain.
4. Use the configured Pi role profile in a regular pane. Do not commit or squash; the orchestrator performs `jj squash` only after approval.
5. Do not update dependencies or run install with a non-frozen lockfile merely to make the gate pass. The existing workspace install and `bun.lock` are the test baseline.

### 2. Understand the gate before running it

Treat root `package.json` as the command authority. `bun run check` runs, in order:

1. root `format:check` (`prettier --check .`);
2. root `policy:check` (`bun test scripts`);
3. Nx `run-many` for every project that defines each requested target:
   - `typecheck`;
   - `test`;
   - `parity`;
   - `format:check`;
   - `package:check`;
   - `smoke`.

Do not replace this command with a hand-selected music-only project list. The purpose of this phase is to prove that the accumulated migration leaves the entire workspace green, including `apnea`, `music-core`, `opencode-music-player`, `opencode-vim`, `pi-apnea`, and `pi-music-dock` targets defined by their existing `project.json` files.

### 3. Run the complete gate once before editing

1. Run `bun run check` from the repository root.
2. Preserve the complete command exit status and enough output to identify each failed root stage or Nx project/target.
3. Allow the command to finish unless a retained live process makes continued execution unsafe. Do not hide failures with shell pipelines, `|| true`, target exclusions, changed Nx parallelism, skipped tests, updated snapshots, or disabled format/policy checks.
4. If the command exits zero, do not edit product or documentation files. Continue directly to hygiene/status verification.

A cache hit is valid Nx execution evidence under the repository's configured cache policy. Do not change cache configuration as part of this phase.

### 4. Diagnose a failure before changing any file

If `bun run check` fails:

1. Identify the first failing stage and its exact project/target from the output.
2. Rerun only that existing command or Nx target with enough diagnostics to establish the root cause. For an Nx result that may be stale, rerun that exact target with `--skip-nx-cache`; do not disable caching globally or alter `nx.json`.
3. Classify the failure before editing:
   - **environment/tooling**: missing Node/npm/Bun/tmux, unavailable exact registry pin, platform mismatch, or external executable setup;
   - **format/policy**: a concrete reported file or repository policy test;
   - **type/test/parity**: a specific compiler/test assertion and owning module;
   - **package/smoke**: a specific packed-file, isolated-resolution, exact-version, lifecycle, or cleanup assertion;
   - **generated debris**: a file/process left by a failed command.
4. Fix environment/tool availability outside the repository when the repository code is correct. Do not weaken a smoke, relax an exact pin, or change a manifest to accommodate an arbitrary local/global executable.
5. If a smoke reports unconfirmed child/process-group termination and a retained temporary root, keep the root and report its path until termination is independently confirmed. Do not delete beneath a possibly live process.
6. If the failure predates or is unrelated to this migration, report it as a blocker rather than cleaning up or refactoring unrelated code.

### 5. Apply only an evidence-backed narrow correction

A correction is allowed only after Step 4 identifies an owning file:

1. Touch the minimum existing file that directly owns the failing assertion.
2. For a formatting failure, run Prettier only on the specifically reported owned file(s); do not run a workspace-wide write that can rewrite unrelated content.
3. For a type/test/parity failure, preserve existing contracts and add/change only what is necessary to repair the demonstrated regression. Do not delete, skip, rename, or loosen the failing test.
4. For a package/smoke failure:
   - keep the core root-only export surface;
   - keep the unique structural packed-core runtime and fail-safe root-retention policy;
   - keep exact OpenCode `0.0.0-next-17386` selection;
   - keep exact Pi `0.84.0` selection and the unchanged supported peer ranges;
   - keep isolated package-name resolution and confirmed-termination-before-deletion behavior.
5. If Effect code must change, use only the repository-pinned Effect TypeScript v4 APIs and retain Layer/scope ownership, Schema/Config boundaries, bounded queues/schedules, and supervised cleanup. Do not introduce Effect v3 APIs or ad hoc ownership/timer replacements.
6. If a correction changes a previously approved phase-owned file, rerun that phase's focused command before the full gate:
   - packed core: `bunx nx run music-core:smoke --skip-nx-cache`;
   - exact OpenCode: `bunx nx run opencode-music-player:smoke --skip-nx-cache`;
   - exact Pi: `bunx nx run pi-music-dock:smoke --skip-nx-cache`;
   - documentation: the Phase 4 Prettier/stale-wording checks.
7. Rerun the originally failing target uncached and require it to pass.
8. Rerun `bun run check` from the root. A focused pass without a final top-level pass is not sufficient.

Do not opportunistically refactor adjacent code, upgrade versions, change package contents, or address unrelated warnings.

### 6. Confirm package-smoke cleanup and repository hygiene

After the successful full gate:

1. Confirm the packed-core smoke completed its installed Node package-name import, manifest-selected daemon, invalid-config, hello/replay, disposal, provider-isolation, bounded idle-exit, and cleanup path.
2. Confirm the OpenCode smoke reported exact isolated `0.0.0-next-17386`, packed plugin/core resolution, real host rendering, exact tmux termination, and cleanup.
3. Confirm the Pi smoke reported exact isolated `0.84.0`, packed dock/core resolution, all three RPC commands, process-group exit, owned-process observation, and cleanup.
4. Inspect `jj status` for repository tarballs, temporary projects, generated lockfiles/configs, sockets, markers, bind reservations, logs, or newly tracked build output.
5. Treat `packages/music-core/dist/music-sessiond.js` as the package's declared ignored build output; do not add it to version control. Any other generated repository content must be attributed and removed only when this run owns it and no process can still use it.
6. Run `git diff --check` to catch whitespace errors in the complete accumulated diff.
7. Preserve dispatcher-created `.apnea` tasks/artifacts and the already-dirty `.apnea/state.json`; do not include them in cleanup.

### 7. Report the full result without claiming mixed-host completion

The coder result should include:

1. the final `bun run check` exit status;
2. a concise stage summary for root format/policy and Nx typecheck/test/parity/format/package/smoke targets;
3. exact packed-core, OpenCode, and Pi smoke evidence visible in the run;
4. every focused rerun/correction, if any;
5. `git diff --check`, `jj diff --summary`, and `jj status` results;
6. any retained external temporary root or environment limitation.

Do not claim that the automated mixed-host unit test or separate host smokes replace Phase 6's controlled interactive macOS mixed-host verification.

## Files to touch

No product, documentation, manifest, test, or configuration file is expected to change.

If and only if the full gate exposes a reproducible repository defect, touch the smallest existing file that owns that exact failure. There is no pre-authorized cleanup or refactor scope.

## Files not to touch

Unless a failing gate proves that a listed product file itself owns the defect, do not touch product or documentation files. In all cases, never touch:

- `.apnea/state.json`
- `bun.lock` for dependency/version drift
- `package.json` or `nx.json` to remove/skip gate stages
- Any `project.json` to remove/skip targets
- Package versions, dependency pins, peer ranges, exports, or publish metadata to bypass a failure
- CI/release workflows
- Passing tests, snapshots, or package allowlists merely to weaken acceptance
- Unrelated dirty files or verified ancestor content
- Retained temporary roots whose process termination is unconfirmed

Do not create a new script, test fixture, package target, ignore rule, lockfile, archive, or verification artifact in the repository.

## Acceptance checks

- Root `bun run check` exits zero without target exclusions or weakened commands.
- Root Prettier and policy checks pass.
- Every project target selected by root Nx `run-many` passes for `typecheck`, `test`, `parity`, `format:check`, `package:check`, and `smoke` where defined.
- The full gate includes successful packed-core Node lifecycle, exact-pinned OpenCode, and exact-pinned Pi smoke evidence.
- Any gate-exposed correction is minimal, owned by the failure, uses Effect v4 when applicable, passes its focused target, and is followed by a fresh successful `bun run check`.
- `git diff --check` passes.
- No owned tarball, temporary install/config/lockfile, socket, marker, bind reservation, log, live child, or unintended tracked build output remains.
- Verified history, unrelated dirty content, `.apnea/state.json`, and `docs/music-session-architecture.html` remain preserved.
- No interactive mixed-host, release, publish, push, or PR claim is made.

## Verify commands

Run from the repository root:

```sh
bun run check
git diff --check
jj diff --summary
jj status
```

All four commands must exit successfully except that `jj diff --summary` and `jj status` may report the intended accumulated changes and dispatcher-owned `.apnea` files. They must not show unexplained generated/runtime debris.

## Dependencies

- Approved current-architecture documentation at `ae742b68`.
- Approved exact Pi package smoke at `dee247d7`.
- Approved exact OpenCode package smoke at `6613d6d1`.
- Approved packed-core Node lifecycle at `863c6e7b`.
- The full verified music-session migration and unrelated workspace projects.
- Existing Bun, Node, npm, Nx, tmux, and macOS environment required by repository targets.

## Non-goals

- Interactive mixed OpenCode/Pi host certification; that is Phase 6.
- New behavior, tests, package targets, scripts, acceptance cases, docs, APIs, or architecture changes.
- Dependency upgrades, lockfile regeneration, pin/range changes, release/version/changelog work, publishing, or tagging.
- Opportunistic formatting/refactoring, unrelated cleanup, or fixing a pre-existing unrelated failure without user direction.
- Git commits, manual squashes, pushes, publication, PR creation/update, or `.apnea/state.json` edits.
