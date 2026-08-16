---
status: done
---

# Phase 9 package: cut OpenCode production over to the session adapter

## Intent

Select the Phase 8 session adapter as OpenCode's production backend and remove OpenCode's duplicate provider authority without presentation regressions.

After this phase, loading the real plugin creates exactly one reconnecting session client. OpenCode owns only controller/view state, waveform projection, host-local artwork catalog/conversion/rendering, and narrow UI intent handling. It must not probe providers, create `createSystemMedia`, start native streams, poll/sample playback, maintain a playback clock, execute `media-control get --now`, or run a general transport queue.

Preserve compact/sidebar controls, loading, errors/toasts, optimistic play/pause/seek presentation where safe, waveform fields, reconnect retention, lower-revision replacement replay, native-artwork catalog fallback, and exact disposal. Pi migration remains Phase 10; package cleanup/smokes remain later phases.

## Files to touch

Only as required:

- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/types.ts`
- `packages/opencode-music-player/tests/controller.test.ts`
- `packages/opencode-music-player/tests/controller-lifecycle.test.ts`
- `packages/opencode-music-player/tests/system-media.test.ts`
- `packages/opencode-music-player/tests/artwork-lifecycle.test.ts`
- `packages/opencode-music-player/tests/package-load.test.ts`

Do not create a new source or test module.

## Files not to touch

- Anything under `packages/music-core/`
- Anything under `packages/pi-music-dock/`
- `packages/opencode-music-player/ui.tsx`
- `packages/opencode-music-player/waveform.tsx`
- `packages/opencode-music-player/artwork.ts`
- `packages/opencode-music-player/artwork.tsx`
- `packages/opencode-music-player/kitty-graphics.ts`
- `packages/opencode-music-player/artwork-placement.ts`
- `packages/opencode-music-player/tmux-offset.ts`
- `packages/opencode-music-player/package.json`
- `packages/opencode-music-player/project.json`
- `packages/opencode-music-player/scripts/package-smoke.ts`
- `packages/opencode-music-player/scripts/verify-pack.ts`
- `bun.lock`
- `README.md`, package READMEs, and `docs/music-session-architecture.html`
- `.apnea/state.json` and unrelated `.apnea` tasks/artifacts

Use the already public core session API; do not add a host-specific core seam.

## Exact implementation steps

### 1. Preserve the approved adapter and presentation baseline

1. Start from approved Phase 8 change `c31a96b6` and retain its one-client factory, lifecycle precedence, lower-revision replacement handling, deterministic public-contract fake, artwork ownership fencing, and async disposal behavior.
2. Retain approved core Phase 1–7 behavior unchanged.
3. Preserve UI components, keybindings, slots, storage key, native image ownership, catalog resolver, conversion, and renderers.

### 2. Select the session adapter in production

In `packages/opencode-music-player/index.tsx`:

1. Replace the default `controllerDependencies.createBackend` selection with `createSessionSystemMedia`.
2. Remove imports and startup checks for host-side `createSystemMedia`, `hasMediaControl`, and `hasNowPlayingCli`.
3. Keep the macOS platform warning if still truthful, but do not probe local provider executables from OpenCode. Missing-tool/degraded feedback must come from daemon `ProviderStatus` through the adapter lifecycle event.
4. Ensure plugin setup/controller construction invokes the backend factory once and therefore creates one session client shared by app and sidebar remounts.
5. Keep dependency injection for tests, but the no-override production path must unambiguously select the session adapter.

### 3. Remove the direct OpenCode system-media backend

In `packages/opencode-music-player/system-media.ts`:

1. Delete the direct host facade that calls core `createSystemMedia` and all dependencies/types used only by it.
2. Delete OpenCode-side provider detection, direct playback sample projection, native `media-control get --now`, raw artwork-sample parsing, and direct core stream subscription.
3. Remove obsolete direct-backend exports (`createSystemMedia`, provider probe re-exports, direct overrides, and raw-native identity parser) once no production/test caller remains.
4. Retain `createSessionSystemMedia`, `openNowPlayingApp`, identity/cache-key helpers needed by host artwork presentation, and host-local resolver/cache/job/presentation logic.
5. Verify `media-control`, `nowplaying-cli`, provider probes, native streams, and playback-clock APIs do not appear in OpenCode production source after the edit.
6. Do not delete low-level core compatibility APIs; this phase removes only OpenCode ownership.

### 4. Remove controller playback polling and sampling lanes

The daemon now owns polling/sampling and pushes replay/live snapshots. In `index.tsx`:

1. Remove `POLL_PLAYING_MS`, `POLL_PAUSED_MS`, `POLL_IDLE_MS`, `pollTimer`, timer scheduling/canceling, sampling/pending-sample state, and provider-style coalesced refresh loops.
2. Do not schedule a timer after initial replay, a live snapshot, a command, reconnect, app/sidebar mount, or manual refresh.
3. Keep `refreshAll` as a narrow compatibility/controller method that reads the session adapter's cached `player()` once, or make it a no-op when a subscription already supplies authoritative replay. It must never trigger provider work.
4. Subscribe before/while acquiring initial state so replay cannot be missed. Avoid duplicate initial snapshot/lifecycle projection from a simultaneous `player()` call.
5. A standalone host invalidation/lifecycle event must not start a sampling lane; reconnecting state is already retained by the adapter.
6. Remove stale-sample sequence/revision machinery whose only purpose was to arbitrate host provider reads (`pendingSample`, `sampleRequestSequence`, `transportRevision`, sampling Promise). Generation fencing remains in the core client/adapter.
7. Keep waveform-compatible state values from daemon snapshots unchanged.

### 5. Remove the general host transport queue

Use the daemon's global FIFO as transport authority.

1. Remove `pendingIntents`, `activeIntent`, the general `runTransport` queue/runner, and host-side command serialization.
2. Each play/pause/next/previous UI call delegates once to the session backend immediately and tracks only its own loading/error completion.
3. Keep a simple pending-operation count/set so `session.loading` remains true while any issued control is unsettled and false after all settle/disposal.
4. Preserve play/pause intent truthfully under rapid input. Use the current/pending presentation target only to choose `play` versus `pause`; do not delay sending behind a host FIFO.
5. Preserve optimistic play/pause and seek projection only after successful command completion, then let daemon live state remain authoritative.
6. Preserve a narrow latest-seek lane if required for high-frequency UI seeks: at most one active seek plus one replaceable latest target whose callers all settle. Do not use it for play/pause/navigation or replay it across reconnect.
7. `next`/`previous` must issue once and await daemon feedback; no host reconciliation sample/timer follows.
8. Commands during reconnect/incompatibility propagate adapter/core errors into existing loading/error/toast behavior. Never retry them.

### 6. Keep lifecycle and transport errors independently truthful

1. Retain Phase 8 lifecycle precedence: reconnect/terminal overrides provider ready; after connected, degraded/unavailable provider status remains visible.
2. Cached `player()` reads and state snapshots must not clear an active lifecycle error.
3. A lifecycle recovery may clear only the lifecycle error it owns, never a later transport error.
4. A successful transport may clear only transport-owned error state and must not erase reconnect/degraded/incompatible feedback.
5. Failed transport shows the existing error toast once and does not schedule provider reconciliation.
6. Replacement connected/replay restores controls without clearing a still-degraded provider message.

### 7. Keep native artwork daemon-backed and presentation host-local

In `system-media.ts`:

1. Keep the Phase 8 native callback exclusively on `client.artwork(fullIdentity)`; no OpenCode native command execution may remain.
2. Preserve mappings:
   - `available` → host resolver native bytes;
   - `unavailable`/`stale`/`too-large`/transient request failure → host-local catalog fallback/retry behavior.
3. Keep iTunes/catalog lookup, HTTP download, image conversion, thumbnail/accent/cells, Kitty/half-block rendering, completion events, and identity-aware merge entirely in OpenCode.
4. Bound both settled cache and unresolved job count. Deduplicate equal work; if distinct pending jobs reach capacity, do not create unbounded entries. Evict only according to deterministic host cache policy.
5. Disposal/identity replacement must remove only that adapter's interests/abandoned work and must not delete a successful cover owned/used by another live adapter.
6. Late generation-A or disposed resolver completion cannot publish onto generation B/current track or clean up a newer native image owner.

### 8. Make production disposal close only this client

1. Controller disposal marks its generation dead before unsubscribing state/lifecycle/presentation listeners and before backend disposal.
2. Stop/settle pending UI callers and narrow seek state without issuing another command.
3. Invoke the adapter's retained idempotent disposal once; safely observe asynchronous completion.
4. Ignore all late state, status, lifecycle, command, artwork, factory, and resolver completions.
5. Do not signal/kill the daemon or remove socket/marker artifacts. Closing OpenCode releases only its negotiated client; other clients keep the daemon alive.

### 9. Rewrite direct-backend tests around production session behavior

In `tests/system-media.test.ts`:

1. Remove tests that assert OpenCode performs direct provider sampling/native reads; equivalent native validation now belongs to core Phase 7 tests.
2. Retain host artwork key, catalog/cache/job, presentation, and ownership tests using the session adapter fake.
3. Assert production adapter construction creates one client and no command runner/provider probe/stream/poll/sample/clock.
4. Cover bounded job admission/eviction and equal-key deduplication after removal of the direct path.
5. Cover all daemon artwork outcomes and late/disposed completion suppression.

### 10. Prove the production controller cutover

In `tests/controller.test.ts`, inject `createSessionSystemMedia` with the deterministic public-contract fake and test the actual simplified controller:

1. Initial replay, live playing/paused/idle snapshots, reconnect retention, lower-revision generation B replay, disconnect, incompatibility, ready/degraded/unavailable status.
2. No scheduled polling after replay, snapshots, lifecycle transitions, commands, or view activity.
3. `refreshAll` performs no native/provider work and cannot erase lifecycle/transport errors.
4. Play/pause/next/previous each delegate once without a general host queue; daemon order is not reimplemented.
5. Rapid seeks retain only the narrow latest-seek behavior and all callers settle; no seek replays after reconnect.
6. Loading spans each pending call correctly, including overlapping controls and disposal.
7. Successful controls preserve optimistic projection; authoritative daemon snapshot wins afterward.
8. Failed/indeterminate/reconnecting/incompatible commands preserve error/toast ownership and issue no reconciliation delay/sample.
9. Playback fields remain suitable for compact/sidebar waveform projection.
10. Artwork loading/completion merges only for matching full identity.

Update old polling/direct-backend expectations rather than retaining dead migration behavior.

### 11. Prove lifecycle, presentation, and package-load behavior

In `controller-lifecycle.test.ts`:

1. Assert zero controller poll timers and zero reconciliation timers on production session paths.
2. Dispose before factory resolution, during held commands, during reconnect, and during held artwork; assert exact caller settlement, one client disposal, and no late mutation/toast/timer/next command.
3. Dispose one of two adapters/controllers and prove the other fake client still receives state/artwork and is not disposed.

In `artwork-lifecycle.test.ts`:

1. Preserve native image ownership and upgrade cleanup assertions.
2. Add session-backed late-completion coverage proving an old controller cannot overwrite/clean a newer owner's image.

In `package-load.test.ts`:

1. Preserve one shared controller/session across app and sidebar remounts.
2. Add production-selector evidence that one setup creates one session adapter/client, both views share its store, and plugin cleanup disposes it once.
3. Use the deterministic factory seam; do not start a real daemon or rely on installed media tools.
4. Missing/degraded provider feedback must be driven by fake daemon status, not local executable probes.

### 12. Keep Phase 9 isolated

1. Do not migrate Pi or add Pi artwork/seek.
2. Do not edit package manifests/lockfile or delete cross-package migration scaffolding reserved for Phase 11.
3. Do not run packed/live host smoke; Phase 13 owns OpenCode smoke certification.
4. Do not redesign compact/sidebar UI, controls, shortcuts, layout, or store key.
5. Format only touched files and inspect the exact diff.
6. Keep work in the current reviewed Jujutsu phase child. Do not run `git commit`, `jj commit`, `jj squash`, push, or open a PR. After approval, the orchestrator may squash only this reviewed phase through the prescribed workflow.

## Acceptance checks

Phase 9 is complete only when:

- Default plugin/controller production selection is `createSessionSystemMedia` and constructs exactly one reconnecting client shared across app/sidebar views.
- OpenCode production contains no direct core `createSystemMedia`, provider/tool probe, native media stream/sample/poll lane, playback clock, direct `media-control get --now`, or general transport queue.
- Replay/live playing, paused, idle, reconnect, replacement, disconnect, incompatibility, and provider degradation preserve player, waveform fields, controls, loading, errors, and toasts.
- Commands delegate once to daemon authority, are never replayed, and local seek handling remains narrowly bounded.
- Native artwork comes only through the daemon; catalog/cache/jobs/conversion/rendering remain bounded, host-local, and identity-safe.
- Disposal closes only this client, is idempotent, suppresses all late work, and leaves another client/controller healthy.
- Existing UI/package-load behavior remains green without a real daemon.
- Core, Pi, manifests, lockfile, docs, and unrelated worktree content remain untouched.

## Verify commands

Run from the repository root:

```sh
bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player
! rg -n 'createSystemMedia|hasMediaControl|hasNowPlayingCli|POLL_PLAYING_MS|pendingSample|transportRevision' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
! rg -n 'media-control.*get.*--now|media-control.*stream|nowplaying-cli|createPlaybackClock' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
jj diff --summary
```

Run the focused production-cutover tests:

```sh
(cd packages/opencode-music-player && bun test --preload @opentui/solid/preload tests/system-media.test.ts tests/controller.test.ts tests/controller-lifecycle.test.ts tests/artwork-lifecycle.test.ts tests/package-load.test.ts)
```

Inspect the exact phase diff:

```sh
jj diff --git packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts packages/opencode-music-player/types.ts packages/opencode-music-player/tests/controller.test.ts packages/opencode-music-player/tests/controller-lifecycle.test.ts packages/opencode-music-player/tests/system-media.test.ts packages/opencode-music-player/tests/artwork-lifecycle.test.ts packages/opencode-music-player/tests/package-load.test.ts
git diff --check
```

Confirm manually:

- default selector names `createSessionSystemMedia`;
- no polling/sample/provider/direct-native/general-command ownership remains in OpenCode production;
- only one client factory call occurs per controller/backend;
- lifecycle and transport error ownership cannot erase one another;
- daemon state remains authoritative after optimistic UI projection;
- artwork presentation code remains OpenCode-local and bounded;
- plugin cleanup disposes only its client and all late callbacks are fenced;
- no core/Pi/manifest/lock/docs file changed;
- `.apnea/state.json` and unrelated dirty paths were not altered.

## Dependencies

- Approved full plan at `.apnea/artifacts/plan.md`.
- Approved Phase 1 (`08acaab5`), Phase 2 (`73a988d6`), Phase 3 (`788473b7`), Phase 4 (`b376a94d`), Phase 5 (`82853612`), Phase 6 (`caf926c9`), Phase 7 (`a234f763`), and Phase 8 (`c31a96b6`) changes.
- Tested `createSessionSystemMedia`, deterministic reconnecting-client fake, lifecycle precedence, async disposal, and host artwork ownership from Phase 8.
- Existing controller/store/UI/package-load tests and OpenCode-local catalog/render pipeline.

## Non-goals

- Pi migration, Pi artwork/seek, footer ownership, command renaming, or mixed-host production proof.
- Core protocol/server/provider changes, new reconnect/idle/fan-out/artwork behavior, remote sockets, or daemon process management from OpenCode.
- UI redesign, shortcut/layout/store-key changes, package manifests, lockfile, packed smoke, READMEs, architecture HTML, publishing, or PR creation.
- New source/test modules, unrelated cleanup, commits or squashing during coding, pushing, opening a PR, or editing `.apnea/state.json`.
