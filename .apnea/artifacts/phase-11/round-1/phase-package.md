---
status: done
---

# Phase 11 package — remove migration scaffolding and finalize package surfaces

## Intent

Now that OpenCode and Pi both use the reconnecting machine-local session client, remove the compatibility scaffolding that existed only to let OpenCode switch between its former direct backend and the session adapter. Finalize the three package manifests and core public/package surface so the next phases can test packed artifacts rather than workspace source.

Keep this phase structural. Preserve the approved Phase 9 and Phase 10 behavior, core's intentional low-level `createSystemMedia()` compatibility API, all singleton/reconnect/idle/fan-out/artwork behavior, exact host versions, and host-local presentation. Do not implement or run the packed Node/OpenCode/Pi lifecycle smokes assigned to Phases 12–14.

## Implementation steps

### 1. Remove OpenCode's obsolete generic-backend compatibility shape

In `packages/opencode-music-player/types.ts`:

1. Replace the host `MusicBackend` type derived from core's direct-provider `MusicBackend` with a narrow session-media contract named for what OpenCode now owns. It should expose only what the current controller uses:
   - current projected player retrieval;
   - play, pause, next, previous, and seek delegation;
   - session snapshot/lifecycle subscription;
   - host-local artwork completion subscription;
   - idempotent asynchronous disposal.
2. Define the session snapshot/lifecycle event and listener types directly from the public session-facing values needed by OpenCode. Do not inherit provider-era invalidation, authentication, search, backend identity, or remote-control fields merely for source compatibility.
3. Keep `PlayerState`, host-local artwork types, `mergeArtworkCompletion`, `emptyPlayer`, formatting, platform, and UI-facing device/error exports that still have real callers.
4. Delete `mergePlayerPresentation` and its `mergePlayer`/`sameTrackIdentity` imports if the production graph no longer uses them. Authoritative daemon snapshots and identity-fenced artwork completion have replaced incomplete direct-provider sample merging.

In `packages/opencode-music-player/system-media.ts`:

1. Return the new narrow session-media contract from `createSessionSystemMedia`.
2. Rename internal generic `backend` terminology only where it represents the removed selectable-backend abstraction; keep provider names that truthfully describe daemon status.
3. Remove fields retained solely to satisfy core's old direct `MusicBackend`: `id`, `label`, `remoteControl`, `authenticated`, `searchTracks`, and provider-era event variants.
4. Keep the existing one-client factory, reconnect/status/state projection, daemon-backed native artwork request, bounded host-local artwork/cache/catalog work, listener isolation, and disposal fences unchanged.
5. Do not move artwork presentation into core or weaken the Phase 9 capacity, identity, retry, or late-completion guarantees.

In `packages/opencode-music-player/index.tsx`:

1. Replace `createBackend`/`backend` naming with the narrow session-media factory/value throughout controller and plugin test seams.
2. Reduce `ControllerDependencies` to dependencies the session controller actually consumes. Delete the explicitly unused `scheduleTimeout`, `clearScheduledTimeout`, and `delay` source-compatibility fields.
3. Remove any now-pointless transport-kind parameter or other direct-backend migration field. Retain the bounded latest-seek coalescer, loading ownership, command error handling, authoritative snapshot epoch, and disposal settlement; those are current UI behavior, not the removed general transport queue.
4. Keep production selection fixed on `createSessionSystemMedia`; do not add another backend selector or direct-provider fallback.

### 2. Update existing OpenCode tests and the deferred smoke fixture mechanically

Update existing callers of the removed compatibility seam in:

- `packages/opencode-music-player/tests/types.test.ts`
- `packages/opencode-music-player/tests/system-media.test.ts`
- `packages/opencode-music-player/tests/controller.test.ts`
- `packages/opencode-music-player/tests/controller-lifecycle.test.ts`
- `packages/opencode-music-player/tests/package-load.test.ts`

Required adjustments:

1. Rename fake factory/media types and fields to the final session-media vocabulary.
2. Remove timer/delay fakes that existed only to prove the session path did not use old polling/reconciliation hooks.
3. Delete only tests for removed, unused direct-sample presentation merging. Preserve tests for player/artwork types and every approved adapter/controller lifecycle, capacity, authority, command, and disposal behavior.
4. Keep the package-load test's evidence that one production session adapter creates one client shared by both OpenCode slots and disposes it once.

`packages/opencode-music-player/scripts/package-smoke.ts` is included in OpenCode's typecheck and embeds the controller seam in a generated fixture. Update only that fixture's renamed factory and deleted timer/delay properties so the workspace remains green. Do not otherwise redesign, strengthen, run, or claim the packed OpenCode smoke in this phase; Phase 13 owns it.

### 3. Confirm and lock the core public API

In `packages/music-core/index.ts` and `packages/music-core/tests/public-api.test.ts`:

1. Keep the supported reconnecting Promise client and all host-consumed session protocol/state/status types exported from the package root.
2. Add a focused public-surface assertion for the reconnecting client/protocol exports used by both hosts if one is not already present.
3. Preserve `createSystemMedia()` and the low-level types/utilities it requires as an intentional compatibility surface. Do not delete core's provider implementation, clock, runner, reconciliation helper, or their tests merely because hosts no longer instantiate them directly.
4. Do not expose server/coordinator/provider ownership as a new host API and do not add unsupported deep-import paths.

Audit `packages/music-core/package.json` and its existing `packages/music-core/scripts/verify-pack.ts`:

1. The root export must resolve to `index.ts`.
2. `naxodev-music-sessiond` must resolve to the built `dist/music-sessiond.js` executable.
3. The `files` allowlist must include the root source needed by compatibility consumers, every `session/*.ts` runtime source needed by the client/daemon package, and the built daemon executable.
4. Tests, scripts, fixtures, maps, logs, temporary files, and unrelated build output must not enter the tarball.
5. Tighten the existing verifier to reject unexpected packed entries, not merely `tests/` and `scripts/`, while retaining the explicit expected-file set. Do not add a second verifier or a new package path.

The current `project.json` and `tsconfig.json` already build and typecheck these files. Change either only if an actual export/build inclusion defect is demonstrated; do not churn compiler or Nx settings speculatively.

### 4. Make host-to-core dependencies publishable and preserve host pins

In both host manifests:

- `packages/opencode-music-player/package.json`
- `packages/pi-music-dock/package.json`

replace the source-only `workspace:*` dependency on `@naxodev/music-core` with the repository's normal publishable compatible range for the current core release (`^0.1.0`). Keep it in `dependencies`, because it is required at runtime from packed host code.

Preserve without widening or upgrading:

- OpenCode's exact `@opencode-ai/plugin`, `@opentui/core`, `@opentui/solid`, and `solid-js` versions;
- Pi's exact `0.84.0` development pins and existing `>=0.83.0 <0.85.0` peer ranges for Pi-provided packages;
- Pi's `pi.extensions` declaration and extension/file allowlists;
- package names, versions, engines, OS restrictions, publish configuration, and entrypoints.

Regenerate `bun.lock` with the repository-pinned Bun version so it records the manifest ranges while continuing to resolve the local `@naxodev/music-core@0.1.0` workspace during development. Do not hand-edit unrelated lock entries and do not change package versions.

### 5. Confirm Pi has no remaining migration ownership

Inspect `packages/pi-music-dock/extensions/music-dock/index.ts`; no production change is expected. It should continue to own one reconnecting client, one acquisition gate, subscriptions, notifications, and local waveform/status work only. The acquisition gate is not a transport queue and must remain intact.

Do not rename Pi commands/shortcuts, alter lifecycle behavior, add artwork/seek, or reintroduce executable probes. Touch the file only if the final forbidden-symbol check reveals actual leftover migration scaffolding.

### 6. Verify package surfaces without entering packed-smoke phases

1. Run focused public API and host tests after the type/seam cleanup.
2. Run all three projects' typecheck, tests, formatting, and package checks.
3. Run core's dry pack with scripts disabled and inspect the allowlisted output. Host package checks must likewise complete without creating retained tarballs.
4. Assert the source and lockfile contain no host `workspace:*` core dependency and no removed OpenCode/Pi ownership symbols.
5. Inspect `jj status` and the package directories for `.tgz`, sockets, markers, bind reservations, logs, temporary installs, or unintended generated files. The ignored `packages/music-core/dist/music-sessiond.js` produced by the declared build is expected for package verification; do not add it to version control.

## Files to touch

Expected product/package files:

- `packages/music-core/index.ts`
- `packages/music-core/package.json`
- `packages/music-core/scripts/verify-pack.ts`
- `packages/music-core/tests/public-api.test.ts`
- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/types.ts`
- `packages/opencode-music-player/package.json`
- `packages/opencode-music-player/tests/types.test.ts`
- `packages/opencode-music-player/tests/system-media.test.ts`
- `packages/opencode-music-player/tests/controller.test.ts`
- `packages/opencode-music-player/tests/controller-lifecycle.test.ts`
- `packages/opencode-music-player/tests/package-load.test.ts`
- `packages/opencode-music-player/scripts/package-smoke.ts` — mechanical final-interface update only; no Phase 13 smoke work
- `packages/pi-music-dock/package.json`
- `bun.lock`

Conditional only on a demonstrated inclusion/typecheck defect:

- `packages/music-core/project.json`
- `packages/music-core/tsconfig.json`
- `packages/pi-music-dock/extensions/music-dock/index.ts`

## Files not to touch

- `packages/music-core/session/**` and session lifecycle/integration tests.
- `packages/music-core/system-media.ts`, `clock.ts`, `run.ts`, `reconcile.ts`, `types.ts`, `waveform.ts`, and their focused tests, except the root public-API assertion named above.
- OpenCode UI/artwork/rendering implementation outside the three listed source files.
- `packages/pi-music-dock/extensions/music-dock/format.ts` and `waveform.ts`.
- `packages/pi-music-dock/test/**`, `project.json`, `tsconfig.json`, and `scripts/**`.
- Root `package.json`, other workspace manifests, and unrelated lockfile entries.
- Any README, `CHANGELOG.md`, `SUPPORT.md`, or `docs/**`, including `docs/music-session-architecture.html`.
- Phase 12–14 packed lifecycle smoke implementations, temporary install fixtures, or exact-host executable logic beyond the mechanical OpenCode fixture update above.
- Generated tarballs, committed `dist/`, runtime socket/marker/reservation files, logs, unrelated dirty changes, and `.apnea/state.json`.

## Acceptance checks

- OpenCode production and its public host-local types contain no generic `MusicBackend`/`CoreMusicBackend`, `createBackend` selector, provider authentication/search/identity compatibility fields, direct-provider invalidation/sample merge, unused timer/delay seams, polling/sampling/playback-clock ownership, or general transport queue.
- The final OpenCode session-media contract contains only current controller/session/artwork/disposal operations. Production still creates one reconnecting client and preserves all Phase 9 replay, lifecycle, command, seek, artwork, authority, and cleanup behavior.
- Pi remains on its Phase 10 direct reconnecting-client contract with no provider probes, polling, sampling, playback clock, reconciliation delay, or general transport queue.
- Core's package root exports the supported reconnecting client and required protocol/state/status types, while `createSystemMedia()` remains exported and behaviorally covered as an intentional compatibility API.
- Core's manifest and verifier prove the root entry, executable `bin`, complete runtime source/bundle allowlist, and exclusion of tests/scripts/unexpected artifacts.
- Both packed host manifests carry a publishable `@naxodev/music-core` range rather than `workspace:*`; the lockfile resolves it to the local `0.1.0` workspace for development.
- OpenCode's exact host dependency pins and Pi's exact development pins/peer ranges are unchanged. Pi's manifest still advertises `./extensions` and treats core as a runtime dependency.
- Package verification leaves no `.tgz`, socket, marker, bind reservation, temporary install, or unintended tracked/generated artifact in the package directories.
- No daemon/client behavior, protocol, host UI, documentation, packed-live acceptance, version, publication, or unrelated worktree content changes in this phase.

## Verification commands

Run from the repository root:

```sh
bun test packages/music-core/tests/public-api.test.ts
bun test --preload @opentui/solid/preload packages/opencode-music-player/tests/types.test.ts packages/opencode-music-player/tests/system-media.test.ts packages/opencode-music-player/tests/controller.test.ts packages/opencode-music-player/tests/controller-lifecycle.test.ts packages/opencode-music-player/tests/package-load.test.ts
bun test packages/pi-music-dock/test/index.test.ts
bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player,pi-music-dock
(cd packages/music-core && npm pack --dry-run --json --ignore-scripts >/dev/null)
! rg -n 'MusicBackend|CoreMusicBackend|createBackend|scheduleTimeout|clearScheduledTimeout|mergePlayerPresentation|POLL_PLAYING_MS|pendingSample|transportRevision|createPlaybackClock' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts packages/opencode-music-player/types.ts packages/pi-music-dock/extensions/music-dock/index.ts packages/opencode-music-player/tests packages/opencode-music-player/scripts/package-smoke.ts
! rg -n 'createSystemMedia|hasMediaControl|hasNowPlayingCli|startLineStream|whichOk|POLL_PLAYING_MS|pendingSample|transportRevision' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts packages/pi-music-dock/extensions/music-dock/index.ts
rg -n 'createSystemMedia|createReconnectingMusicSessionClient|ReconnectingMusicSessionClient|RevisionedState|ProviderStatus' packages/music-core/index.ts
! rg -n '"@naxodev/music-core": "workspace:' packages/opencode-music-player/package.json packages/pi-music-dock/package.json bun.lock
bun -e 'const oc = await Bun.file("packages/opencode-music-player/package.json").json(); const pi = await Bun.file("packages/pi-music-dock/package.json").json(); if (oc.dependencies["@naxodev/music-core"] !== "^0.1.0" || pi.dependencies["@naxodev/music-core"] !== "^0.1.0") throw new Error("host core range changed"); if (oc.dependencies["@opencode-ai/plugin"] !== "0.0.0-next-17386" || oc.dependencies["@opentui/core"] !== "0.5.2" || oc.dependencies["@opentui/solid"] !== "0.5.2" || oc.dependencies["solid-js"] !== "1.9.12") throw new Error("OpenCode host pin changed"); if (pi.devDependencies["@earendil-works/pi-coding-agent"] !== "0.84.0" || pi.devDependencies["@earendil-works/pi-tui"] !== "0.84.0" || pi.peerDependencies["@earendil-works/pi-coding-agent"] !== ">=0.83.0 <0.85.0" || pi.peerDependencies["@earendil-works/pi-tui"] !== ">=0.83.0 <0.85.0" || pi.pi.extensions.join(",") !== "./extensions") throw new Error("Pi package surface changed")'
! find packages/music-core packages/opencode-music-player packages/pi-music-dock -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.bind-lock*' -o -name '*.log' -o -name '*.tmp' \) -print -quit | grep -q .
git diff --check
jj diff --summary
jj status
```

The Nx matrix and dry packs are package/regression checks only. Do not run or claim the Phase 12 core installed-Node lifecycle smoke, Phase 13 exact-OpenCode host smoke, or Phase 14 exact-Pi host smoke here.

## Dependencies

- Approved Phase 9 OpenCode cutover at `a40bda4e`, including its final bounded artwork fixes.
- Approved Phase 10 Pi cutover at `bfb04663`, including acquisition gating, recovered notification deduplication, and mixed-host FIFO evidence.
- Existing core root exports, `naxodev-music-sessiond` build, explicit package `files` allowlist, and package verifier.
- Repository package convention for internal publishable semver dependencies and repository-pinned Bun `1.3.7`.
- Pi package rules: runtime third-party dependencies belong in `dependencies`; Pi-provided APIs remain peers and are not bundled.
- Repository-pinned Effect TypeScript `4.0.0-beta.101`; this phase must not add or upgrade Effect.

## Non-goals

- Removing or redesigning core's low-level `createSystemMedia()`, provider, clock, runner, reconciliation, waveform, or compatibility exports.
- Changing protocol, daemon ownership/shutdown, singleton/startup, reconnect, idle, fan-out, native artwork, command semantics, or diagnostics.
- Changing OpenCode or Pi UI, controls, shortcuts, artwork presentation, seek behavior, status/waveform rendering, or lifecycle feedback.
- Adding package versions, publishing configuration changes, release/version bumps, publishing, or dependency upgrades.
- Building the installed-package Node daemon/client lifecycle verifier, strengthening/running exact-pinned OpenCode or Pi live smokes, or documenting the architecture.
- Committing, squashing, pushing, opening a PR, or editing `.apnea/state.json`; the orchestrator performs the reviewed-child `jj squash` only after approval.
