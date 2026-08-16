---
status: done
---

# Phase 1 package — accept the installed packed-core Node daemon/client smoke

## Intent

Finish only the dirty installed-package smoke for `@naxodev/music-core`. The current implementation already reports a passing smoke; verify it against the achievable policies in this package and accept it without source churn if it passes.

This package supersedes the abandoned contradictory requirements. Keep the current package export surface, supply a unique managed runtime structure directly to the installed public client, remove owned runtime files only after termination is confirmed, and retain/report the temporary root if the harness process group cannot be confirmed dead.

Do not exercise or change OpenCode, Pi, documentation, broader core behavior, or full-repository gates in this phase.

## Exact steps

### 1. Preserve and inspect the dirty baseline

1. Run `jj status` before making any source change.
2. Preserve all verified ancestors through `31f1c2d4`, the existing dirty packed-core implementation, all `.apnea` state/artifacts, `docs/music-session-architecture.html`, and unrelated changes.
3. Inspect only the four phase-owned files listed below. Confirm that the dirty implementation already wires the `music-core:smoke` target to the installed-smoke mode and that the daemon's short idle-grace option continues through the existing Effect v4 configuration validation.
4. Do not reset, clean, restore, abandon, rebase, commit, or squash. The orchestrator performs `jj squash` only after approval.

### 2. Adopt the package export/runtime policy explicitly

Treat the following as the required policy; do not attempt to satisfy the abandoned package's contradictory resolver requirement:

1. Leave `packages/music-core/package.json` exports unchanged. The public root remains the existing `".": "./index.ts"`; do not add `resolveMusicSessionRuntimePaths` to the root and do not add a config subpath.
2. In the generated Node harness, import the installed public client/protocol values using the package name `@naxodev/music-core`. Do not import workspace source or construct a source `file://` URL.
3. Create one unique temporary smoke root and supply a structurally valid runtime object directly to the installed client:
   - `directory` is beneath that unique root;
   - `socketPath` and `markerPath` are beneath `directory` and use the production-compatible compact names;
   - `uid` is the current numeric UID;
   - no path points at the default developer runtime or outside the unique root.
4. Do not require the harness to call the unexported installed `resolveMusicSessionRuntimePaths`. A unique structurally supplied runtime is the accepted managed-runtime boundary for this smoke.

### 3. Verify the installed Node lifecycle

Run the existing smoke before editing. It must demonstrate only this lifecycle:

1. Build and pack core, install the tarball and declared dependencies in an isolated temporary project, and execute the lifecycle harness under Node.
2. Resolve the public package import from that isolated install.
3. Read the installed package manifest and select the daemon from its `naxodev-music-sessiond` bin entry. Do not use workspace source, `PATH`, or a hard-coded fallback as the executable-selection authority.
4. Invoke that installed daemon with invalid idle-grace configuration and prove it fails through the normal configuration/status boundary without retaining its runtime files.
5. Start the manifest-selected daemon through the installed reconnecting client's launcher and complete real hello plus state/status replay from the same daemon instance.
6. Isolate provider discovery with the harness's controlled executable environment. A replayed provider-unavailable status is expected and sufficient; do not invoke developer-installed `media-control` or `nowplaying-cli`.
7. Await client disposal, then await the exact daemon's status-zero idle exit under the smoke's bound.
8. After confirmed process termination, prove successful cleanup of the owned socket, startup marker, bind reservation and temporaries, archive, install project, runtime root, and temporary smoke root.

If the command passes and reports the installed package root, manifest-selected daemon, negotiated daemon/replay, status-zero idle exit, and cleanup success, make no product-code change.

### 4. Preserve fail-safe cleanup semantics

Apply this ordering on every success or failure path:

1. Track each client, child, process group, runtime path, archive, install project, and temporary root as soon as it is acquired.
2. Dispose an acquired client and terminate only the exact owned child/process group.
3. Await and confirm process termination before recursively deleting runtime or temporary-root contents.
4. On a successful smoke, termination must be confirmed and all owned temporary content must be removed.
5. If process-group termination cannot be confirmed, fail the smoke, retain the entire unique temporary root, and print its path in the failure diagnostics. Do not delete socket/runtime/install files beneath the possibly live process and do not conceal the retained root.
6. Never use `pkill`, `killall`, a broad process match, the default production runtime, or cleanup based only on a guessed path.

### 5. Make a correction only if focused acceptance fails

If the existing smoke fails one of the acceptance checks:

1. Diagnose the specific failure from captured child stdout/stderr.
2. Change only the smallest phase-owned file necessary.
3. Preserve the existing package export and structural-runtime policies above.
4. If `music-sessiond.ts` must change, use the repository-pinned Effect v4 configuration/error path; do not add a second timer, daemon mode, test graph, or direct environment configuration.
5. Rerun the complete phase verification commands.

Do not broaden acceptance or modify code merely to produce a new diff.

## Files to touch

No product file should be touched when the existing smoke passes. A focused correction may touch only:

- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/scripts/verify-pack.ts`
- `packages/music-core/session/music-sessiond.ts`

## Files not to touch

- `packages/music-core/index.ts`
- `packages/music-core/session/config.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/framing.ts`
- `packages/music-core/tests/**`
- `packages/opencode-music-player/**`
- `packages/pi-music-dock/**`
- `README.md`
- `packages/music-core/README.md`
- `docs/music-session-architecture.html`
- `package.json`
- `bun.lock`
- `.apnea/state.json`
- Any unrelated dirty file, generated archive, checked-in harness, lockfile, or temporary runtime/install file

## Acceptance checks

- The current package export surface is unchanged; no resolver export or subpath is added.
- Installed public client/protocol code is imported by package name from the isolated install.
- The runtime is unique, structurally supplied beneath the temporary root, and does not require the unexported resolver.
- The daemon executable is selected from the installed manifest's bin entry.
- Invalid daemon configuration fails through the installed executable's normal status/diagnostic boundary.
- The installed client and daemon complete hello plus state/status replay, and client disposal is awaited.
- Provider discovery is isolated from developer-installed tools; provider-unavailable replay is acceptable.
- The exact daemon reaches bounded status-zero idle exit.
- On success, owned runtime/install/archive artifacts are deleted after confirmed process termination.
- If process-group termination cannot be confirmed, the smoke fails and reports a retained temporary root rather than deleting beneath a possibly live process.

## Verify commands

Run from the repository root:

```sh
bunx nx run music-core:smoke --skip-nx-cache
! find packages/music-core -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.bind-lock*' -o -name '*.log' -o -name '*.tmp' \) -print -quit | grep -q .
jj diff --summary
jj status
```

Expected successful smoke output identifies the installed package root and manifest-selected daemon, reports negotiated hello/replay evidence, and ends with status-zero idle-exit/cleanup success. A failed unconfirmed-termination path must instead identify the retained temporary root.

Do not run `music-core:package:check`, broad core test matrices, OpenCode/Pi smokes, `bun run check`, or mixed-host checks as Phase 1 acceptance.

## Dependencies

- The dirty packed-core implementation already present in the worktree.
- Verified package/client/daemon behavior through `31f1c2d4`.
- Node satisfying the engine floor in `packages/music-core/package.json`.
- The package-declared Effect TypeScript v4 dependency.

## Non-goals

- Exporting `resolveMusicSessionRuntimePaths` or adding any package subpath/export.
- Unconditional deletion after unconfirmed process-group termination.
- Changing package contents, versions, dependencies, protocol, startup, reconnect, idle defaults, provider ownership, server topology, or shutdown design.
- Broad package validation, unit/integration test expansion, playback commands, provider success, artwork, host rendering, or UI behavior.
- OpenCode exact-pin smoke, Pi exact-pin smoke, docs/current architecture, full repository checks, mixed-host verification, or PR-description work.
- Committing, squashing, pushing, publishing, opening a PR, editing `.apnea/state.json`, or cleaning unrelated worktree changes.
