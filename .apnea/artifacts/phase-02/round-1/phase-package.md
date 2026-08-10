---
status: done
---

# Phase 2: End-To-End Independent Artwork Projection

## Intent

Remove artwork work from the playback delivery path. The OpenCode system-media facade must return and forward normalized playback state immediately, start artwork work independently, and publish a separate presentation event when that work settles. The controller must synchronously apply authoritative snapshots and merge matching artwork events into the current session without another provider sample, stream event, or poll.

This phase completes the artwork producer-to-controller slice. It does not yet replace the controller's sampling scheduler or transport latches; those changes belong to phase 3.

## Dependencies

- Phase 1 authoritative core snapshot and invalidation events must be present.
- Work on top of the phase 1 result based on `fix/music-player-sync` without modifying PR #40.

## Files To Touch

- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/types.ts`
- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/tests/system-media.test.ts`
- `packages/opencode-music-player/tests/types.test.ts`
- `packages/opencode-music-player/tests/controller.test.ts`

Do not add files unless the implementation cannot remain clear within this list.

## Files Not To Touch

- `packages/music-core/**`
- `packages/pi-music-dock/**`
- `packages/opencode-music-player/artwork.ts`
- `packages/opencode-music-player/artwork.tsx`
- `packages/opencode-music-player/kitty-graphics.ts`
- `packages/opencode-music-player/ui.tsx`
- Other package source, tests, and documentation
- Package versions, changelogs, lockfiles, release metadata, and CI configuration
- `.apnea/state.json`
- PR #40 or its branch history

## Required Contract

1. `MusicBackend.player()` returns normalized playback state without awaiting native artwork sampling, catalog lookup, download, conversion, retry delay, or an existing artwork job.
2. A playback track is returned with cached artwork when available. Otherwise it is returned with `artwork: null` and an accurate `artwork_loading` presentation flag while eligible work is pending.
3. A complete recording identity consists of title, artist, album, and duration. It is the keyed artwork-work and presentation-matching identity. Keep the raw provider ID alongside it only for validating native artwork from the second `media-control get --now` sample.
4. Volatile provider ID changes alone must not create a second artwork job or prevent matching artwork from decorating the same recording.
5. At most one artwork job may run for a complete recording identity. Concurrent callers share that job and retain the existing 32-entry cache bound, three-attempt limit, and 2/4/8-second retry delays.
6. Add a host-specific presentation subscription that is distinct from the core playback subscription. Its event carries a stable discriminant, the complete recording identity, the resolved `Artwork | null`, and resolved duration metadata.
7. Core snapshot and invalidation events remain distinct and are forwarded by the facade. Snapshot state must receive the same immediate cached/loading projection as explicit `player()` results.
8. Wrapping a core subscription must preserve its disposer exactly once. Presentation subscription disposal must be idempotent and suppress later delivery to that listener.
9. Artwork success or failure must never set playback error state, show a toast, request a sample, alter a poll deadline, or delay playback projection.
10. The controller may merge only `artwork`, `artwork_loading`, and duration enrichment from an artwork event. It must not copy play state, progress, fetch time, device, repeat, shuffle, or other playback fields from asynchronous artwork work.
11. The controller must ignore artwork events for a replaced recording and every event received after disposal.
12. Existing `MusicBackend` transport methods, `Promise<void>` contracts, controller methods, UI callback signatures, `Artwork` shape, and Kitty-facing behavior remain unchanged.
13. The controller must consume a valid authoritative snapshot payload directly and synchronously project its host `PlayerState`. It must not replace that payload with a `player()` refresh or wait for artwork, polling, command settling, or another provider operation. Existing invalidation-triggered refresh behavior remains in place until phase 3.

Keep the presentation event host-specific. Do not add artwork fields or artwork events to `@naxodev/music-core`.

## Implementation Steps

1. Define the host artwork event seam in `packages/opencode-music-player/types.ts`.
   - Move or define the reusable artwork identity type with raw provider ID plus title, artist, album, and duration.
   - Define a discriminated artwork-completion event carrying that identity, `Artwork | null`, and resolved `duration_ms`.
   - Define the presentation listener and disposer signatures.
   - Override the inherited core `subscribe` type as needed so snapshot events carry the OpenCode `PlayerState` shape with artwork presentation fields.
   - Add an optional, separately named presentation subscription to `MusicBackend`; do not overload core snapshot/invalidation events with artwork completion.

2. Refactor artwork cache entries in `packages/opencode-music-player/system-media.ts` so lookup and scheduling are synchronous.
   - Replace the awaited `artworkForTrack` path with a function that returns current cached artwork, resolved duration, and loading state immediately.
   - Start eligible work with a detached promise and attach completion handling immediately so rejections are handled.
   - Store one pending job per `artworkCacheKey`, not one per provider ID or caller.
   - Let each cache entry retain deduplicated completion interests for facade instances that requested the identity while the shared job was pending.
   - On settlement, update the cache entry before notifying interested facades. Clear pending state on both success and failure.
   - Preserve FIFO eviction at 32 entries, three total attempts per retained entry, and retry deadlines of 2/4/8 seconds after unsuccessful attempts.
   - Treat resolver rejection as a failed artwork result. Do not throw it through `player()` or a subscription callback.

3. Keep native artwork validation and catalog behavior unchanged.
   - Continue the second `media-control get --now` only inside the detached artwork job.
   - Validate `artworkData` against the full raw native identity, including provider ID, before passing it to `resolveArtworkDetails`.
   - Continue catalog fallback, conversion, dimensions, byte limits, and the existing `Artwork` result shape through the unchanged artwork module.
   - Add a narrow injectable resolver dependency to the facade only if needed for deterministic deferred tests. Default it to the existing `resolveArtworkDetails`, and strip it before passing overrides to `music-core`.

4. Create one playback-to-presentation projection function in the facade.
   - Return null and trackless states without starting artwork.
   - For a track, derive the complete artwork identity and cache key once.
   - Read or start the keyed artwork job without awaiting it.
   - Return the original playback fields with only `track.artwork`, `track.artwork_loading`, and missing duration enrichment applied.
   - Use this same function for explicit `core.player()` results and core snapshot events so both paths have identical presentation behavior.

5. Forward core subscriptions through the facade.
   - Forward invalidations unchanged.
   - For snapshots, synchronously project cached/loading artwork state and forward the resulting host snapshot without calling `core.player()`.
   - Preserve an omitted event for legacy no-argument notification compatibility rather than inventing a snapshot.
   - Return a wrapper disposer that invokes the core disposer at most once and suppresses all later forwarded callbacks.
   - Keep `subscribe` absent when the selected core backend is polling-only.

6. Publish artwork completion independently.
   - Maintain presentation listeners per facade instance rather than globally.
   - When a shared job settles, publish one artwork event to each interested live facade with the identity associated with that facade's request.
   - Publish null artwork on handled failure so a matching controller can end its loading presentation; a later eligible sample may start the bounded retry.
   - Do not issue a playback event, provider sample, or retry timer from publication.
   - Make each presentation disposer idempotent. A disposed listener must not receive an already-pending completion.

7. Consume authoritative snapshots and presentation events in `packages/opencode-music-player/index.tsx`.
   - Subscribe to core and presentation events before starting the initial refresh so a fast snapshot or artwork completion cannot be missed.
   - On an artwork event, first check the controller lifecycle and current track.
   - Match the current track by complete recording metadata, tolerating provider ID changes alone and rejecting title, artist, album, or incompatible duration changes.
   - Mutate only the current track's artwork presentation fields. Set `artwork_loading` false and use resolved duration only when the current playback duration is missing.
   - Do not call `requestRefresh`, clear an error, show a toast, stop or schedule polling, or change loading for an artwork event.
   - Store the presentation disposer separately from the core event disposer. Invoke each at most once during controller disposal.
   - Consume authoritative core snapshot payloads directly and synchronously assign their projected host state to the live session. Do not request `player()` for a valid snapshot or wait for artwork completion.
   - Keep invalidation-triggered refresh behavior in place. Phase 3 owns recovery scheduling, stale-sample arbitration, and transport-lane changes.

8. Extend `packages/opencode-music-player/tests/system-media.test.ts` with deterministic lane and cache coverage.
   - Hold an injected artwork resolver unresolved and assert `player()` settles first with the correct playback fields and `artwork_loading: true`.
   - While that job remains unresolved, forward a core paused or changed-track snapshot and assert the host snapshot listener runs immediately without another explicit provider sample.
   - Resolve the artwork job and assert the separate presentation listener receives identity, artwork, and duration metadata.
   - Call `player()` concurrently for the same complete recording identity, including a changed provider ID, and assert the resolver starts once.
   - Assert a later cache hit returns artwork synchronously without another resolver call.
   - Assert resolver failure settles as null presentation, does not reject playback, and retains bounded retry behavior.
   - Assert a title, artist, album, or duration change gets a separate job and completion identity.
   - Assert core and presentation disposers are each idempotent and suppress pending late completions.
   - Use unique recording identities per test so the bounded module cache cannot leak outcomes between tests.

9. Extend `packages/opencode-music-player/tests/types.test.ts` for the matching/merge rule.
   - Assert matching recording metadata accepts a volatile provider ID and applies artwork.
   - Assert changed title, artist, album, or duration rejects the completion.
   - Assert artwork merging preserves current playback, progress, fetch timestamp, device, repeat, and shuffle fields.
   - Assert resolved duration enriches only a missing duration and cannot replace a known current duration.

10. Add the end-to-end controller regression in `packages/opencode-music-player/tests/controller.test.ts`.
    - Build the controller with the real facade and deterministic core/artwork dependencies, or a harness that exercises the same typed facade subscriptions without bypassing the producer seam.
    - Leave artwork resolution and a fallback `player()` refresh pending, emit an authoritative playback snapshot, and assert `session.player` synchronously reflects that snapshot with loading presentation.
    - Resolve artwork and assert matching `session.player.track.artwork` updates without a new `player()` call, core event, timer fire, or manual refresh.
    - Replace track A with track B before resolving A and assert A cannot decorate B or overwrite any B playback field.
    - Dispose before another completion and assert no session mutation, toast, provider request, or timer activity occurs afterward.

## Acceptance Checks

- A paused or changed playback snapshot reaches the facade's playback subscriber while an earlier artwork promise remains unresolved.
- An authoritative paused or changed playback snapshot updates `session.player` synchronously while artwork and fallback refresh work remain unresolved, without another `player()` call.
- `MusicBackend.player()` settles with usable playback state and `artwork_loading: true` before unresolved artwork work settles.
- Resolving artwork updates the matching controller session without another `player()` call, core event, poll, or manual refresh.
- Late artwork for track A cannot decorate track B or overwrite B's playback fields.
- A provider ID change alone still accepts matching artwork for the same complete recording metadata.
- Concurrent requests for one complete recording identity share one job and preserve the 32-entry cache, three-attempt limit, and 2/4/8-second retry delays.
- Failed artwork resolution does not reject playback, set a playback error, show a toast, or delay transport state.
- Core snapshots and invalidations remain correctly typed and forwarded, and the core disposer runs exactly once.
- Controller disposal removes both subscriptions exactly once and suppresses every late snapshot and artwork completion.
- Existing artwork selection, native identity validation, conversion, image safety, Kitty rendering, controller methods, and transport callback signatures remain unchanged.

## Verify Commands

Run from the repository root:

```sh
bunx nx run-many -t typecheck test format:check --projects=opencode-music-player
```

The phase is complete only when every target passes.

## Non-Goals

- Replacing the OpenCode global busy latch, seek latch, or transport execution behavior
- Changing polling cadence, invalidation-triggered refresh behavior, stream-recovery scheduling, or stale-sample transport revisions
- Parallel transport commands, transport promise cancellation, or command queue semantics
- Pi event adoption or Pi transport changes
- Changes to catalog matching, download policy, conversion, image limits, Kitty placement, terminal escape sequences, or layout
- Stream support for `nowplaying-cli`
- Package version, release, changelog, or storage-key changes
- Modifying, force-pushing, or adding commits to PR #40
