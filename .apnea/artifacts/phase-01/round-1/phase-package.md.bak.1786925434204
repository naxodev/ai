---
status: done
---

# Phase 1 package: review the two package-smoke corrections and pass the complete gate

## Intent

Review and retain the current child changes relative to approved policy-only parent `b30f9987`, limited to the OpenCode and Pi package-smoke scripts. These changes must safely report absent synchronous diagnostics and must keep Pi RPC stream validation within exact detached-process-group cleanup. Then run both focused uncached package smokes and the literal unchanged root `bun run check`.

Do not broaden this phase. If verification exposes an environmental failure or a defect outside these two scripts, diagnose and report it instead of changing unrelated files or weakening a check.

## Files to touch

Only these product files may be edited, and only if review finds that the already-present correction needs a narrow adjustment:

- `packages/opencode-music-player/scripts/package-smoke.ts`
- `packages/pi-music-dock/scripts/package-smoke.ts`

The expected child already contains the intended corrections, so no additional product edit is required if the review checks below pass.

Apnea may create or advance its dispatched records through the normal workflow. Do not manually edit, restore, reformat, or delete any `.apnea/**` file, especially `.apnea/state.json`.

## Files not to touch

Do not change:

- any other product source, test, policy, package, lock, Nx/root configuration, or documentation file;
- `.prettierignore`, `package.json`, `bun.lock`, or `docs/music-session-architecture.html`;
- unrelated dirty work or any verified ancestor;
- `.apnea/state.json` or other Apnea records outside normal dispatched artifact writing.

Do not reset or clean the worktree. Do not commit, squash, push, publish, release, or open a PR. The orchestrator owns the post-approval `jj squash` workflow.

## Exact steps

1. **Confirm the phase boundary before editing.**
   - Verify that `@-` resolves to a commit ID beginning `b30f9987`.
   - Inspect `jj diff --from @- --summary` and ignore only `.apnea/**` records when determining the product slice.
   - Require the non-Apnea diff to contain exactly the two scripts listed above. Stop and report any additional non-Apnea path; do not restore or modify it.

2. **Review the OpenCode correction against `@-`.**
   - In `packages/opencode-music-player/scripts/package-smoke.ts`, require the synchronous `output` helper to render missing `stdout` or `stderr` as `""` via null-safe access rather than calling `.toString()` unconditionally.
   - Confirm this changes diagnostics only. Do not weaken failure conditions for packing, temporary isolated installation, pinned OpenCode version, packed package resolution, rendered app/sidebar slots, state/layout checks, or exact tmux server cleanup.
   - Preserve the package's current required formatting. Formatting-only changes already present alongside the diagnostic correction are acceptable; do not reformat unrelated files.

3. **Review the Pi correction against `@-`.**
   - In `packages/pi-music-dock/scripts/package-smoke.ts`, require the synchronous `output` helper to use the same null-safe empty fallback for absent `stdout` and `stderr`.
   - Require `child.stdin`, `child.stdout`, and `child.stderr` to be checked for missing or numeric/non-piped values before any stream capture, write, or read.
   - Keep that validation inside the existing RPC lifecycle `try` so every launch/lifecycle failure enters the `catch` that terminates the exact detached process group (`-child.pid`), captures whatever output is available, and reports termination failure if one occurs.
   - Confirm the normal path waits for status-zero exit and process-group disappearance before parsing the response. Confirm the outer `finally` again waits for or terminates the exact process group, checks that no process from the installed `music-core` root remains, and removes the temporary root only after confirmed cleanup.
   - Do not weaken isolated packed-resolution checks, exact Pi/peer pin checks, packed extension exposure, `/music`, `/music-next`, and `/music-prev` registration checks, RPC response validation, or cleanup checks.
   - Preserve the package's current required formatting.

4. **Make only a necessary narrow correction.**
   - If all review conditions already hold, leave both files as they are.
   - If one condition does not hold, edit only the affected script and only enough to satisfy it. Use repository-pinned Effect v4 if an Effect edit unexpectedly becomes necessary; do not introduce another Effect version. No Effect edit is expected in this phase.

5. **Reconfirm scope before expensive tests.**
   - Run the parent-ID and exact two-path commands from the verification section.
   - Inspect the final two-file diff. Ensure no assertion, pin, lifecycle boundary, or cleanup guarantee was removed.

6. **Run focused smokes uncached, sequentially.**
   - Run the OpenCode package smoke first. It must install and execute the exact pinned OpenCode package from an isolated packed install, validate both UI slots/layout states, and clean its exact tmux server and temporary root.
   - Run the Pi package smoke second. It must install exact Pi `0.84.0` and the packed dock/core in isolation, register all three extension commands, exit zero, terminate its exact process group, leave no installed core process, and remove its temporary root.
   - Do not substitute cached Nx results.

7. **Run the complete unchanged root gate.**
   - Run exactly `bun run check`; do not replace it with selected targets or edit its definition.
   - This must execute root `format:check`, root `policy:check`, and all configured Nx `typecheck`, `test`, `parity`, `format:check`, `package:check`, and `smoke` targets.

8. **Check final hygiene and report.**
   - Run `git diff --check`.
   - Confirm no smoke-owned `.tgz`, socket, bind-lock, log, or temporary file remains under `packages`.
   - Reconfirm the parent and exact non-Apnea two-file scope after all commands.
   - Report each command and result. If anything fails, preserve the evidence and identify whether it is in-scope or environmental; do not commit, clean, or broaden the change.

## Acceptance checks

- `@-` is approved policy-only parent `b30f9987…`.
- Excluding `.apnea/**`, the child diff from `@-` contains exactly:
  - `packages/opencode-music-player/scripts/package-smoke.ts`
  - `packages/pi-music-dock/scripts/package-smoke.ts`
- Both synchronous diagnostic helpers tolerate absent `stdout` and `stderr` while retaining available output.
- OpenCode retains exact pin `0.0.0-next-17386`, isolated packed resolutions, rendering/layout assertions, and exact tmux-server cleanup.
- Pi retains exact pin `0.84.0`, peer/package isolation checks, extension command registration, successful RPC/status-zero requirements, and installed-core cleanup.
- Pi validates piped streams before use and within the failure boundary that terminates the exact detached process group; output capture is safe even when validation fails.
- Both focused uncached package smokes exit zero.
- The literal unchanged `bun run check` exits zero, including format, policy, typecheck, test, parity, package, and smoke coverage.
- `git diff --check` exits zero.
- No smoke-owned archive, socket, bind-lock, log, or temporary file remains under `packages`.
- No unrelated product file, architecture document, verified history, unrelated dirty work, or manually managed Apnea state is changed.

## Verify commands

Run from the repository root. Every line is self-contained and suitable for execution by `apnea commit` in a fresh shell:

```sh
jj log -r @- --no-graph -T 'commit_id' | grep -q '^b30f9987'
actual="$(jj diff --from @- --summary | awk '$2 !~ /^\.apnea\// { print $2 }' | sort)"; expected="$(printf '%s\n' packages/opencode-music-player/scripts/package-smoke.ts packages/pi-music-dock/scripts/package-smoke.ts | sort)"; test "$actual" = "$expected"
bunx nx run opencode-music-player:smoke --skip-nx-cache
bunx nx run pi-music-dock:smoke --skip-nx-cache
bun run check
git diff --check
test -z "$(find packages -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.bind-lock*' -o -name '*.log' -o -name '*.tmp' \) -print -quit)"
```

## Dependencies

- Approved parent `b30f9987` and its verified ancestors.
- The two current child corrections.
- Installed Bun, npm, Nx, Node, tmux, macOS tooling, and registry access required by the existing package smokes.
- Orchestrator ownership of the post-approval Jujutsu squash and phase boundary.

## Non-goals

- Real mixed OpenCode/Pi host certification; that belongs to Phase 2.
- Product behavior changes, refactoring, protocol or lifecycle redesign, dependency updates, host-pin changes, new tests, or weakened tests.
- Changing `bun run check`, root/Nx settings, package metadata, lockfiles, policy, architecture documentation, or unrelated work.
- Commits or squashes by the coder/reviewer, pushes, publication, releases, or PR creation.
