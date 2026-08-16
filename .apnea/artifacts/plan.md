---
status: done
---

# Plan: finish the shared Effect v4 music-session migration

## Goal restatement

Finish the migration from the current dirty Jujutsu worktree without resetting, cleaning, abandoning, or rewriting verified work. Preserve the verified commit chain through `ae742b68` (`docs(music): document shared session architecture`), `docs/music-session-architecture.html`, all current and dispatcher-generated Apnea records, unrelated changes, the approved one-line root Prettier policy edit, and the current narrow OpenCode/Pi package-smoke corrections.

The remaining work is four small slices: review and commit only the already-present `.prettierignore` policy edit; run and, only where evidence requires it, narrowly repair the unchanged complete repository gate while retaining both package-smoke corrections; verify one real mixed OpenCode/Pi session in regular panes; then write the dispatcher-requested `pr-description.md` artifact. Any Effect change must use only the repository-pinned Effect v4 (`4.0.0-beta.101`). Roles use their configured Pi profiles in regular panes. Coding/review agents do not commit; after approval the orchestrator commits only the reviewed slice through the run's prescribed `jj squash` workflow. Do not use Git commits, push, publish, release, open a PR, or manually edit `.apnea/state.json`.

## Phases

### Phase 1 — Review and commit only the existing Prettier policy edit

**Intent**

Review the already-present `.prettierignore` change and commit it as its own phase. Do not edit it again if it already has the exact approved bytes. The approved change retains the original four lines and adds exactly one final `.apnea/` line so root Prettier ignores workflow runtime records.

The commit gate must be reproducible in a fresh shell. It must not depend on coder-created temporary files, shell functions, environment variables, or hashes/snapshots of `.apnea`; Apnea necessarily updates its own records while dispatching, reviewing, verifying, and committing.

**Files likely touched**

- `.prettierignore` — already changed; review and commit this path only, with no new content edit expected.

Apnea may create or update its own task, artifact, state, backup, and verify-log records as part of normal workflow operation. No agent may edit those records manually. The existing dirty package-smoke scripts must remain uncommitted and unchanged for Phase 2.

**Acceptance checks**

- `.prettierignore` is byte-for-byte exactly five newline-terminated lines: `bun.lock`, `node_modules/`, `.nx/`, `**/dist/`, and `.apnea/`.
- There is exactly one line equal to `.apnea/`, and it is the final line.
- Prettier reports `.apnea/state.json` as ignored.
- The read-only root format check passes, and the accumulated diff has no whitespace errors.
- No coder-owned edit is made in this phase. In particular, neither package-smoke script, any `.apnea` file, `package.json`, `.prettierrc.json`, `bun.lock`, architecture documentation, or product source changes.
- The approved phase commit contains only `.prettierignore` among repository policy/product paths. The two package-smoke corrections remain present for the next reviewed phase, and verified ancestors are not folded into or rewritten by this phase.

**Verify commands**

Each line is intentionally self-contained because `apnea commit` executes each command in a fresh `bash -lc` process:

```sh
printf '%s\n' 'bun.lock' 'node_modules/' '.nx/' '**/dist/' '.apnea/' | cmp - .prettierignore
test "$(grep -cFx '.apnea/' .prettierignore)" -eq 1
bunx prettier --file-info .apnea/state.json | grep -q '"ignored": true'
bun run format:check
git diff --check
```

**Dependencies**

- The current approved one-line `.prettierignore` worktree edit.
- The existing root `format:check` command and Prettier configuration.
- Orchestrator support for isolating only the reviewed phase path while preserving the remaining dirty work on top.

**Non-goals**

- Adding or changing the policy line, formatting `.apnea`, hashing mutable workflow records, or proving they remain static while Apnea operates.
- Running the full `bun run check`, editing or committing the package-smoke corrections, fixing product code, or changing formatting configuration.
- Resetting/cleaning unrelated work, rewriting verified commits, using Git mutation commands, pushing, or PR work.

### Phase 2 — Retain the package-smoke corrections and pass the unchanged full gate

**Intent**

Review the two current package-smoke corrections, run the literal root `bun run check`, and commit the corrections as their own approved phase. The expected result is no new product behavior: OpenCode diagnostics tolerate absent synchronous child output; Pi does the same and validates that its RPC child actually supplied piped stdin/stdout/stderr inside the existing termination and cleanup boundary.

If the gate fails, identify the exact failing stage and owner before editing. Make only the smallest evidence-backed correction in that owner, rerun its existing focused target uncached, and then rerun the unchanged complete root gate. Do not alter the root command, omit targets, weaken a smoke, change exact host pins, or normalize Apnea records.

**Files likely touched**

- `packages/opencode-music-player/scripts/package-smoke.ts` — retain the current nullable synchronous-output correction and its Prettier formatting.
- `packages/pi-music-dock/scripts/package-smoke.ts` — retain the current nullable synchronous-output and piped-RPC-stream corrections and its package-specific Prettier formatting.

No additional file is expected. Another existing owner may be touched only when the unchanged gate provides direct, reproducible evidence that it owns a migration regression.

**Acceptance checks**

- Both dirty script corrections remain functionally intact; they are not reverted merely to reduce the diff.
- OpenCode and Pi typechecks pass uncached.
- The exact isolated OpenCode `0.0.0-next-17386` smoke and exact isolated Pi `0.84.0` smoke pass uncached, including packed-package resolution and cleanup.
- The literal unchanged `bun run check` exits zero. Root format and policy checks run, and Nx completes every selected `typecheck`, `test`, `parity`, `format:check`, `package:check`, and `smoke` target.
- The full gate retains packed music-core Node daemon/client lifecycle evidence plus the exact OpenCode, exact Pi, and unrelated package smokes.
- Any new correction is limited to the demonstrated owner and uses Effect v4 only if Effect is involved. Its focused target and the final full gate both pass afterward.
- No package pin/range, root script, lockfile, architecture document, verified commit, `.apnea` record, or unrelated dirty change is rewritten or removed.
- No repository tarball, temporary install/config, socket, startup marker, bind reservation, log, or unintended build output remains.
- The approved phase commit contains only the reviewed package-smoke corrections and any explicitly evidenced narrow fix among product paths; the Phase 1 policy commit and verified ancestors remain separate.

**Verify commands**

```sh
bunx nx run opencode-music-player:typecheck --skip-nx-cache
bunx nx run pi-music-dock:typecheck --skip-nx-cache
bunx nx run opencode-music-player:smoke --skip-nx-cache
bunx nx run pi-music-dock:smoke --skip-nx-cache
bun run check
git diff --check
test -z "$(find packages -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.bind-lock*' -o -name '*.log' -o -name '*.tmp' \) -print -quit)"
```

If an additional target required a correction, its exact existing Nx target with `--skip-nx-cache` must be inserted before the final `bun run check`; a focused pass never replaces the final root gate.

**Dependencies**

- Approved and separately committed Phase 1 policy boundary.
- Verified migration commits through `ae742b68`.
- The two current dirty package-smoke corrections and the repository's installed Bun/Node/npm/Nx/tmux/macOS tooling.

**Non-goals**

- Broad formatting, refactoring, dependency updates, protocol/lifecycle redesign, new acceptance behavior, documentation changes, release work, or manual mixed-host verification.
- Editing `.apnea`, changing `bun run check`, disabling Nx targets/cache policy, relaxing pinned host versions, or accepting focused checks in place of the full gate.
- Git commits, pushes, publication, or PR creation.

### Phase 3 — Verify one real mixed OpenCode/Pi session

**Intent**

After the automated gate is green, certify the real macOS host boundary with active media: one exact OpenCode host loading the current checkout plugin and one exact Pi host loading the current checkout extension in separate regular interactive panes. This is an evidence-only phase; no product edit is expected.

Use temporary host configuration outside the repository. OpenCode must use the README-supported absolute path to `packages/opencode-music-player`; Pi must run the exact tested `@earendil-works/pi-coding-agent@0.84.0` and load `packages/pi-music-dock`. Do not use a different global Pi or a package-smoke fixture as a substitute for the real session.

**Files likely touched**

- No product, policy, documentation, or repository file.
- Temporary host configuration only under an external `mktemp` directory, removed after the session.

Normal dispatcher-owned Apnea evidence records may change. If the live session exposes a product defect, stop the evidence run, return to a narrow owner correction, rerun Phase 2's focused checks and full gate, and restart the live session from a clean runtime.

**Acceptance checks**

- The focused automated mixed-host regression passes before interactive testing.
- OpenCode reports exactly `opencode2 v0.0.0-next-17386`; the launched Pi reports exactly `0.84.0`; a supported provider is installed; and real media is active.
- Both regular-pane hosts load the current checkout integrations and show the same track and playback state.
- A transport action initiated in OpenCode converges in Pi, and a transport action initiated in Pi converges in OpenCode.
- While both hosts are live, there is one daemon generation, one owner-only socket at `/tmp/naxodev-music-$(id -u)/s.sock`, and one provider stream/poll owner.
- Pi `/reload` preserves the same daemon/provider ownership and healthy OpenCode session, while leaving one Pi status/client lifecycle rather than duplicating it.
- Closing Pi leaves OpenCode live and controllable. Closing the final OpenCode client permits the 30-second idle grace to complete, after which no daemon, socket, startup marker, or bind reservation remains.
- Temporary configuration is removed, and the evidence phase creates no product diff or manual `.apnea` edit.

**Verify commands**

Automated prerequisites and the final cleanup state are commit-gate checks; the interactive observations must also be recorded in the coder result and confirmed by review.

```sh
bun test packages/music-core/tests/session-server.test.ts -t 'mixed-host Pi and OpenCode clients share FIFO and survive Pi reload'
test "$(opencode2 --version)" = 'opencode2 v0.0.0-next-17386'
bunx --package @earendil-works/pi-coding-agent@0.84.0 pi --version | grep -qx '0.84.0'
command -v media-control >/dev/null || command -v nowplaying-cli >/dev/null
! pgrep -f '[m]usic-sessiond' >/dev/null
test ! -e "/tmp/naxodev-music-$(id -u)/s.sock"
test ! -e "/tmp/naxodev-music-$(id -u)/start.lock"
test ! -e "/tmp/naxodev-music-$(id -u)/s.sock.bind-lock"
git diff --check
```

During the live run, use `lsof` on the socket and process inspection to record daemon/provider PIDs before and after Pi `/reload`; require identical ownership. Launch exact Pi in its regular pane with the current checkout package:

```sh
bunx --package @earendil-works/pi-coding-agent@0.84.0 pi --no-extensions -e "$PWD/packages/pi-music-dock"
```

Launch OpenCode `--standalone` in the other regular pane using temporary configuration whose plugin entry is the absolute current-checkout `packages/opencode-music-player` path. Wait through the bounded idle grace after both hosts close before running the final cleanup checks.

**Dependencies**

- Approved Phase 2 full gate and separately committed package-smoke corrections.
- macOS, active media, exact OpenCode/Pi versions, supported provider tooling, and regular interactive panes.
- The local-checkout loading instructions in both package READMEs.

**Non-goals**

- New host migration, synthetic scale work, UI redesign, provider/protocol changes, remote sockets, service installation, source edits, or accepting automated/package-smoke evidence instead of real host behavior.
- Using an unpinned global Pi, floating panes, Git commits, pushes, releases, or PR operations.

### Phase 4 — Produce the terminus PR-description artifact

**Intent**

When terminus dispatch provides the exact `pr-description.md` artifact path, write only that artifact. Summarize delivered phases and actual evidence without creating, updating, or opening a pull request.

**Files likely touched**

- Only the exact PR-description artifact path supplied by the terminus dispatch. Do not guess or create a path in advance.

**Acceptance checks**

- Front matter contains only `status: done`.
- The body accurately summarizes the preserved Effect v4 migration, the separate `.apnea/` Prettier policy commit, retained package-smoke corrections, green unchanged full gate, and real mixed-host evidence.
- The test plan distinguishes commands actually run from interactive observations actually completed.
- Residual risk identifies the macOS/provider dependency and beta exact-host boundaries.
- The description agrees with final Jujutsu history/status and does not claim a push, publication, release, or opened PR.
- No product source, architecture documentation, unrelated dirty content, or `.apnea/state.json` is manually edited.

**Verify commands**

```sh
jj log -r 'ancestors(@, 30)' --no-graph -T 'commit_id.short() ++ " " ++ description.first_line() ++ "\n"'
git diff --check
jj status
```

Also inspect the dispatcher-supplied artifact directly to confirm its front matter and every test/evidence claim; the exact path is intentionally deferred until dispatch supplies it.

**Dependencies**

- Approved Phase 3 live evidence and cleanup.
- The terminus dispatch's exact artifact path.

**Non-goals**

- Product changes, release notes, new tests solely to inflate the description, commits, pushes, publication, or creating/updating a PR.

## Whole-run definition of done

- The verified migration commit chain through `ae742b68`, `docs/music-session-architecture.html`, current and newly generated Apnea records, and unrelated work remain preserved.
- The root `.prettierignore` has one separately reviewed/committed change: exactly one final `.apnea/` line after the unchanged original four entries. Its commit gate uses only self-contained fresh-shell checks and does not hash mutable Apnea records.
- The current OpenCode/Pi package-smoke corrections remain intact and are reviewed/committed separately from the policy edit.
- The literal unchanged `bun run check` passes root format/policy and all selected Nx typecheck, test, parity, format, package, and smoke targets, including packed Node music-core and exact pinned OpenCode/Pi evidence.
- Any additional correction is narrow, evidence-backed, owned by the failure, and Effect v4-only where Effect is involved. No generated package/runtime debris remains.
- One real regular-pane macOS session proves mixed OpenCode/Pi state and controls, singleton daemon/socket/provider ownership, Pi reload isolation, remaining-host health, and bounded final idle cleanup.
- Configured Pi role profiles and regular panes are used. Coding/review agents do not commit; the orchestrator isolates and commits only each approved phase through the prescribed `jj squash` workflow without rewriting verified ancestors or absorbing unrelated dirty work.
- The dispatcher-requested PR-description artifact truthfully records delivered phases, tests, interactive evidence, and residual risk.
- No manual `.apnea/state.json` edit, reset, clean, abandon, Git commit, push, publish, release, or PR creation occurs.
