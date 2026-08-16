---
status: done
---

# Plan: finish the machine-local Effect v4 music-session migration

## Goal restatement

Continue from the current dirty Jujutsu worktree without resetting, cleaning, abandoning, or replaying already verified work. Preserve the complete verified music-session chain through `31f1c2d4`, the accumulated dirty packed-core Node harness in `packages/music-core`, `docs/music-session-architecture.html`, Apnea artifacts/state already present, and every unrelated worktree change.

Only seven narrow slices remain: accept the installed packed-core smoke under achievable ownership policies, make the OpenCode smoke use its exact pin, make the Pi smoke use its exact pin, document the architecture as current, run the full repository gate, perform mixed-host verification, and write the terminus PR-description artifact. Do not reopen approved provider, coordinator, server, protocol, runtime-security, startup, reconnect, idle-exit, fan-out, artwork, or host-migration work unless one of these remaining gates exposes a focused regression.

Use only the repository-pinned Effect TypeScript v4 APIs for any product-code correction. Run planner, coder, and reviewer roles through their configured Pi role profiles in regular panes. Coding and review rounds do not commit. After a phase is approved, the orchestrator alone uses the run's `jj squash` workflow for that reviewed phase before creating the next phase child. Never use Git commits, push, publish, open a PR, edit `.apnea/state.json`, or discard unrelated changes.

## Phases

### Phase 1 — Accept the installed packed-core Node daemon/client smoke

**Intent**

Finish only the currently dirty installed-package lifecycle smoke. The existing passing implementation is acceptable if it proves the listed lifecycle behavior under the explicit policies below; do not manufacture source churn merely because the abandoned phase package demanded an unexported resolver or unsafe unconditional cleanup.

**Files likely touched**

No source edit is expected if the existing smoke passes. If a focused defect is exposed, limit changes to the already-owned packed-core files:

- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/scripts/verify-pack.ts`
- `packages/music-core/session/music-sessiond.ts`

**Acceptance checks**

- Keep the current package export surface unchanged: the harness imports the installed public client/protocol API by package name, and no root or subpath export is added for `resolveMusicSessionRuntimePaths`.
- Supply a unique, structurally valid managed runtime beneath the smoke's unique temporary root. Requiring the installed but unexported resolver is explicitly not part of acceptance.
- The harness runs under an allowed Node version, resolves `@naxodev/music-core` from the isolated install, and launches the daemon selected from the installed manifest's `naxodev-music-sessiond` entry rather than workspace source, a hard-coded fallback, or `PATH`.
- The manifest-selected daemon rejects invalid idle-grace configuration through its normal status/diagnostic boundary without retaining runtime artifacts.
- The installed reconnecting client completes negotiated hello plus state/status replay from the same non-empty daemon instance, then completes awaited disposal.
- An isolated executable environment prevents selection of developer-installed provider tools; provider-unavailable replay is valid evidence that provider discovery is isolated.
- After client disposal, the exact daemon reaches bounded, status-zero idle exit and emits the expected lifecycle diagnostics.
- Owned socket, startup marker, bind reservation, bind temporaries, archive, install project, and temporary root are deleted only after process termination is confirmed.
- If exact harness process-group termination cannot be confirmed on a failure path, fail the smoke, retain the temporary root, and report its path instead of deleting beneath a possibly live process. A successful run must confirm termination and report successful cleanup.

**Verify commands**

```sh
bunx nx run music-core:smoke --skip-nx-cache
! find packages/music-core -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.bind-lock*' -o -name '*.log' -o -name '*.tmp' \) -print -quit | grep -q .
jj diff --summary
jj status
```

**Dependencies**

- The current dirty packed-core harness and daemon CLI change.
- The verified package surface and daemon/client lifecycle through `31f1c2d4`.
- Node satisfying `packages/music-core/package.json` and the packed manifest's Effect v4 dependency.

**Non-goals**

- Exporting `resolveMusicSessionRuntimePaths`, adding a package subpath, or changing the current package file surface.
- Deleting a retained root when its process group might still be live.
- Package allowlist expansion, broad core tests, host smokes, host rendering, playback commands, documentation, full-repository checks, or mixed-host acceptance. Those are not Phase 1 acceptance criteria.
- Protocol, startup, reconnect, idle, provider, server, or shutdown redesign.

### Phase 2 — Certify the packed OpenCode plugin with its exact manifest pin

**Intent**

Make the existing packed OpenCode smoke self-contained and prove it runs against the exact OpenCode version selected by `packages/opencode-music-player/package.json`, not an arbitrary executable found on the developer's `PATH`.

**Files likely touched**

- `packages/opencode-music-player/scripts/package-smoke.ts`
- `packages/opencode-music-player/package.json` only if wiring is required; do not change the pin

**Acceptance checks**

- The smoke derives `0.0.0-next-17386` from the exact `@opencode-ai/plugin` dependency and installs/resolves the matching OpenCode CLI inside its isolated temporary project.
- The launched `opencode2` realpath is beneath that isolated install and reports exactly the manifest-selected version; a global or unrelated `PATH` binary cannot satisfy the smoke.
- Packed `@naxodev/opencode-music-player` and packed `@naxodev/music-core` resolve from the isolated install, with no workspace-source import fallback.
- The real pinned host loads the packed plugin and retains the existing session-backed deterministic presentation evidence for expanded, paused, collapsed, narrow, and smallest layouts.
- Cleanup terminates the exact host/tmux resources and removes archives and the temporary install on success and failure; no daemon, host, tmux server, socket, marker, reservation, or log is left behind.

**Verify commands**

```sh
bunx nx run opencode-music-player:smoke --skip-nx-cache
! find packages/opencode-music-player -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.log' -o -name '*.tmp' \) -print -quit | grep -q .
jj diff --summary
jj status
```

**Dependencies**

- Phase 1's accepted packed core.
- Existing OpenCode package-smoke target, packed UI fixture, and exact manifest pin.
- `tmux` and the platform requirements already used by the smoke.

**Non-goals**

- Updating the OpenCode pin, accepting a compatible range, redesigning UI, adding layout cases, exercising a live media provider, changing music-session semantics, Pi verification, or documentation.

### Phase 3 — Certify the packed Pi extension with its exact manifest pin

**Intent**

Make the packed Pi RPC smoke select and execute the package's exact tested Pi version from its isolated install rather than resolving an arbitrary global `pi` binary.

**Files likely touched**

- `packages/pi-music-dock/scripts/package-smoke.ts`
- `packages/pi-music-dock/package.json` only if smoke wiring is required; do not change pins or peer ranges

**Acceptance checks**

- The smoke derives the exact tested `0.84.0` versions from the package's `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` development pins and confirms they satisfy the declared peer ranges.
- Packed `@naxodev/pi-music-dock`, packed `@naxodev/music-core`, and the exact Pi packages are installed in one isolated temporary project without workspace-source fallback.
- The executed `pi` realpath comes from that temporary install, and installed manifest/version evidence proves it is exactly the selected pin; `Bun.which("pi")` or a global `PATH` binary is not accepted.
- The exact Pi host loads the packed extension in RPC mode and reports `/music`, `/music-next`, and `/music-prev` as extension commands.
- EOF/teardown exits within a bounded time without inherited client/daemon/provider handles. Exact children and owned runtime/archive/install artifacts are cleaned on success and failure.

**Verify commands**

```sh
bunx nx run pi-music-dock:smoke --skip-nx-cache
! find packages/pi-music-dock -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.log' -o -name '*.tmp' \) -print -quit | grep -q .
jj diff --summary
jj status
```

**Dependencies**

- Phase 1's accepted packed core.
- Existing Pi RPC smoke and exact package pins in `packages/pi-music-dock/package.json`.

**Non-goals**

- Widening or narrowing Pi peer support, changing the tested pin, Pi artwork/seek, interactive rendering, live media-provider success, OpenCode verification, or product lifecycle redesign.

### Phase 4 — Document the completed architecture as current

**Intent**

Bring the preserved architecture HTML and package documentation in line with the already-delivered machine-local session architecture. Remove language that still presents per-host provider ownership as current or the daemon as a future scale path.

**Files likely touched**

- `README.md`
- `packages/music-core/README.md`
- `packages/opencode-music-player/README.md`
- `packages/pi-music-dock/README.md`
- `docs/music-session-architecture.html`

**Acceptance checks**

- Documentation presents 20+ OpenCode/Pi clients connecting through one same-user Unix socket daemon to one provider subscription as the current architecture.
- It accurately explains Effect v4 services/Layers/scopes, singleton startup, negotiated versions/capabilities, replay and revisions, global FIFO commands, bounded fan-out, slow-client isolation, reconnect across generations without command replay, indeterminate in-flight commands, zero-client idle exit, and owned-artifact cleanup.
- Native artwork acquisition is daemon-owned and bounded; OpenCode retains catalog lookup, download, conversion, caching, and terminal rendering. Pi and OpenCode retain only their client lifecycle and host-local presentation/notification work.
- Compatibility text explains that supported mixed client versions share a daemon while an incompatible client fails actionably without replacing the healthy generation.
- Host requirements and tested-version prose agree with the exact current OpenCode and Pi manifests/smokes.
- `docs/music-session-architecture.html` retains its skip link, labeled navigation/diagrams, source links, responsive and print behavior, reduced-motion support, and established visual language.

**Verify commands**

```sh
bunx prettier --check README.md packages/music-core/README.md packages/opencode-music-player/README.md packages/pi-music-dock/README.md docs/music-session-architecture.html
! rg -n 'Direct / current|Broker / scale path|future broker|when coordination is required' docs/music-session-architecture.html packages/music-core/README.md packages/opencode-music-player/README.md packages/pi-music-dock/README.md
jj diff --summary
jj status
```

**Dependencies**

- The approved architecture through Phase 3 and all previously verified migration phases.
- The preserved `docs/music-session-architecture.html` as the visual baseline.

**Non-goals**

- New runtime behavior, an unrelated documentation-site redesign, changing package pins, generated diagrams, changelog/release work, or publication.

### Phase 5 — Run the full repository gate

**Intent**

Run the repository's complete automated gate against the accumulated migration and exact-pin smokes. Make only narrow fixes directly exposed by this gate, then repeat it from the repository root.

**Files likely touched**

No file is expected. If the gate exposes a defect, touch only the existing file that owns that defect and rerun its focused target before repeating the full gate.

**Acceptance checks**

- `bun run check` passes, including formatting, policy, typecheck, tests, parity, package checks, and all discovered smoke targets.
- The packed-core Node lifecycle and both exact-pinned host smokes pass as part of the repository gate rather than only in isolation.
- Any correction uses repository-pinned Effect v4 where Effect is involved and does not reopen unrelated architecture.
- No generated tarball, temporary install, socket, marker, bind reservation, log, or unintended tracked build output remains.
- Verified history, unrelated dirty content, Apnea state, and the architecture HTML remain present.

**Verify commands**

```sh
bun run check
git diff --check
jj diff --summary
jj status
```

**Dependencies**

- Phases 1–4.

**Non-goals**

- Mixed-host manual certification, feature work, opportunistic refactoring, dependency upgrades, release/version changes, publishing, or PR work.

### Phase 6 — Verify one real mixed OpenCode/Pi host session

**Intent**

Separately certify mixed-host behavior on macOS after all automated repository checks. This is an evidence phase, not another migration phase.

**Files likely touched**

No product file is expected. If the focused automated or real-host check exposes a defect, change only its existing owner and rerun Phase 5 before repeating this phase.

**Acceptance checks**

- The focused real-socket regression proves OpenCode and Pi identities share one global FIFO and one provider subscription, and Pi disposal/reload leaves OpenCode healthy.
- With the exact-pinned OpenCode and Pi hosts and provider tooling available on macOS, both hosts display the same active track and playback state.
- A transport action initiated from either host converges in both; commands remain globally ordered.
- The live session has one `naxodev-music-sessiond` process, one owned socket at the configured same-user runtime, and one provider stream/poll owner. Pi reload does not duplicate any of them.
- Closing either host leaves the other healthy. Closing the final host leads to bounded idle exit and removal of owned socket/marker/reservation artifacts; no host or provider child remains because of the extensions.
- Missing provider tooling and protocol incompatibility remain actionable host feedback and do not trigger replacement of a healthy daemon.

**Verify commands**

Run the automated mixed-host evidence first:

```sh
bun test packages/music-core/tests/session-server.test.ts -t 'mixed-host Pi and OpenCode clients share FIFO and survive Pi reload'
bunx nx run opencode-music-player:smoke --skip-nx-cache
bunx nx run pi-music-dock:smoke --skip-nx-cache
```

During the controlled interactive macOS check, use the exact hosts certified above and inspect the real ownership boundary with runnable commands:

```sh
test -S "/tmp/naxodev-music-$(id -u)/s.sock"
pgrep -fl 'naxodev-music-sessiond'
pgrep -fl 'media-control stream|nowplaying-cli'
lsof -U "/tmp/naxodev-music-$(id -u)/s.sock"
```

After both hosts exit and the configured idle grace elapses:

```sh
for attempt in $(seq 1 40); do
  if ! pgrep -f 'naxodev-music-sessiond' >/dev/null && \
     test ! -e "/tmp/naxodev-music-$(id -u)/s.sock" && \
     test ! -e "/tmp/naxodev-music-$(id -u)/start.lock" && \
     test ! -e "/tmp/naxodev-music-$(id -u)/s.sock.bind-lock"; then
    exit 0
  fi
  sleep 1
done
exit 1
```

**Dependencies**

- Phase 5's green full repository gate.
- macOS, the exact host versions certified in Phases 2–3, and either `media-control` or the supported fallback for the live check.

**Non-goals**

- UI redesign, load testing beyond the already verified 24-client coverage, remote sockets, daemon installation as a service, new diagnostics, documentation edits, or release work.

### Phase 7 — Produce the terminus PR-description artifact

**Intent**

When the terminus dispatch supplies its exact artifact path, write only the PR description artifact. Do not create, update, or open a pull request.

**Files likely touched**

- Only the dispatcher-provided PR-description artifact; no product source and no invented artifact path.

**Acceptance checks**

- Front matter contains `status: done` only.
- The description accurately summarizes the preserved verified migration, packed-core Node lifecycle, exact-pinned OpenCode and Pi smokes, current-architecture documentation, full repository gate, and mixed-host evidence.
- The test plan lists commands/evidence actually completed and distinguishes automated from interactive checks.
- Residual risk is explicit, especially macOS/provider and beta-host constraints.
- Claims match Jujutsu history and the final diff and do not claim publication, push, or an opened PR.

**Verify commands**

```sh
jj log -r 'ancestors(@, 30)' --no-graph -T 'commit_id.short() ++ " " ++ description.first_line() ++ "\n"'
jj diff --summary
jj status
```

**Dependencies**

- Approved Phase 6 evidence.
- The terminus dispatch's exact artifact path.

**Non-goals**

- Product edits, commits, pushes, publication, release tagging, or creating/updating a PR.

## Whole-run definition of done

- Every previously verified migration change through `31f1c2d4`, the accumulated packed-core harness, unrelated worktree content, Apnea state, and `docs/music-session-architecture.html` are preserved; no reset, clean, abandonment, or unrelated rewrite occurs.
- The packed core runs its public client under Node by package name, selects the installed manifest daemon, proves invalid configuration, isolated provider discovery, hello/replay, awaited disposal, bounded status-zero idle exit, and successful owned-artifact cleanup.
- The core package export surface remains unchanged. A unique structurally supplied runtime is accepted, and an unconfirmed process group causes a reported retained root rather than unsafe deletion.
- Packed OpenCode runs against exactly `0.0.0-next-17386` from its isolated install, and packed Pi runs against exactly `0.84.0` from its isolated install; neither smoke accepts an arbitrary global host binary.
- READMEs and the preserved architecture HTML describe one machine-local daemon/provider as current while accurately separating daemon authority from host-local presentation and artwork rendering.
- `bun run check` passes with no generated/runtime debris.
- Focused and real macOS mixed-host evidence shows one daemon/socket/provider, shared state and FIFO commands, reload isolation, healthy remaining clients, and final idle cleanup.
- Each approved phase follows configured Pi role profiles in regular panes and the reviewed-phase `jj squash` workflow. No Git commit, push, publish, release, PR creation, or `.apnea/state.json` edit is performed.
- The final PR-description artifact is complete at the exact path supplied by its terminus dispatch.
