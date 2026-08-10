---
status: done
---

# Phase 1: Backend-Scoped Clock And Authoritative Core Events

## Intent

Deliver the host-consumable `music-core` contract required by later phases. Each `createSystemMedia()` backend must own its playback clock. A `media-control stream` subscription must emit normalized authoritative snapshots immediately and emit one immediate invalidation when a stream generation terminates.

This phase changes the core contract and tests only. It does not change OpenCode or Pi scheduling yet.

## Dependencies

- None.
- Work on top of `fix/music-player-sync` without modifying PR #40.

## Files To Touch

- `packages/music-core/clock.ts`
- `packages/music-core/system-media.ts`
- `packages/music-core/types.ts`
- `packages/music-core/index.ts`
- `packages/music-core/tests/clock.test.ts`
- `packages/music-core/tests/system-media.test.ts`
- `packages/music-core/README.md`

Do not add files unless the implementation cannot remain clear within this list.

## Files Not To Touch

- `packages/opencode-music-player/**`
- `packages/pi-music-dock/**`
- Other package source, tests, and documentation
- Package versions, changelogs, lockfiles, release metadata, and CI configuration
- `.apnea/state.json`
- PR #40 or its branch history

## Required Contract

1. Keep `MusicBackend.subscribe` optional.
2. Change its listener additively so a listener may receive one discriminated event argument. Existing `() => void` listeners must remain valid and may ignore the argument.
3. Define one event variant for an authoritative normalized `PlayerState` snapshot.
4. Define one event variant for invalidation. Its reason must identify stream termination.
5. A valid complete stream payload is authoritative. Normalize and emit it at arrival without calling or awaiting `player()`.
6. An invalid stream line emits nothing. It must not prevent later valid lines from being processed.
7. One stream generation emits at most one terminal invalidation even if error, exit, and close all occur.
8. Stream restart delays remain `1_000`, `2_000`, `4_000`, and then `8_000` milliseconds for every later consecutive failure. Any valid data snapshot resets the next delay to `1_000` milliseconds.
9. `nowplaying-cli` remains polling-only and does not expose `subscribe`.
10. Every `createSystemMedia()` result owns independent clock state for sampling, idle transitions, play, pause, seek, next, and previous.

Use stable discriminant and field names that later host phases can narrow without inspecting payload shape. Export the event and listener types from the package root.

## Implementation Steps

1. Refactor `packages/music-core/clock.ts` around an explicit clock instance or closure.
   - Move the mutable clock and remembered duration out of module scope and into the instance.
   - Put sample reconciliation, reset, play/pause mutation, and seek mutation on that instance.
   - Preserve current reconciliation behavior: track identity and enrichment, explicit zero progress, 400 ms drift correction, duration clamping, sticky play state, and injected timestamps used by deterministic tests.
   - Keep genuinely stateless helpers such as `liveFromClock` and `trackKey` public.
   - If the existing stateful helper exports remain public, require an explicit clock argument or replace them with a documented clock factory/type. Do not retain a hidden singleton for compatibility.

2. Create one clock inside each `createSystemMedia()` invocation in `packages/music-core/system-media.ts`.
   - Pass that instance through all media decoding and idle-state paths.
   - Mutate it only after successful play, pause, or seek commands.
   - Reset only that instance after idle, next, and previous transitions.
   - Preserve command argv, failures, fallback behavior, and `Promise<void>` interfaces.

3. Extract a single decoder for `media-control` samples.
   - Accept the parsed `media-control get` object and a complete stream envelope payload through the same path.
   - Capture `Date.now()` once per decoded sample and use that value for both clock reconciliation and `PlayerState.fetched_at`.
   - Preserve `elapsedTimeNow` precedence, explicit `playing`, playback-rate fallback, provider ID, bundle selection, idle detection, normalization, and millisecond conversion.
   - Keep `nowplaying-cli` normalization behavior unchanged while routing its clock work through the backend-owned instance.

4. Extend `packages/music-core/types.ts` with the subscription event union and event-bearing listener.
   - The snapshot event carries the complete normalized `PlayerState`.
   - The invalidation event carries the stream-termination reason.
   - Keep `subscribe` optional and the disposer synchronous and idempotent.
   - Update `packages/music-core/index.ts` to export new public types and any explicit clock API.

5. Update `subscribeToMediaControl` to decode and emit snapshots directly.
   - Parse only JSON object envelopes with `type: "data"` and a non-array object payload.
   - Treat only payloads that the shared decoder can normalize as authoritative snapshots.
   - Ignore malformed JSON, non-data envelopes, invalid payloads, and partial payloads that cannot represent a complete sample.
   - Do not call `player()` from the stream callback.
   - Reset retry backoff only after a valid snapshot is decoded and emitted.

6. Make terminal handling generation-safe.
   - On the first terminal callback for the active generation, invalidate that generation, dispose its source, emit exactly one stream-termination invalidation immediately, and schedule one restart.
   - Ignore duplicate terminal callbacks and every callback from stale generations.
   - Keep capped exponential restart backoff at 1/2/4/8 seconds.
   - Ensure synchronous terminal callbacks during stream startup cannot leave an active stale disposer or duplicate timer.

7. Keep subscription disposal idempotent.
   - Mark the subscription disposed before releasing resources.
   - Invalidate the active generation.
   - Clear the pending retry timer once.
   - Dispose the active stream once.
   - Suppress every late line, terminal callback, snapshot, invalidation, and restart.

8. Rewrite clock tests around explicit instances.
   - Retain the existing reconciliation behavior tests without global `beforeEach` resets.
   - Add a regression proving two clock instances can represent different tracks and play states without interference.
   - Include transport mutations in the isolation proof so play, pause, seek, and reset affect only their owner.

9. Expand system-media tests with deterministic stream and lifecycle coverage.
   - Assert a complete stream payload with `playing: false` emits an authoritative paused `PlayerState` immediately and makes zero `media-control get` calls.
   - Assert polled and streamed media-control data use the same normalization semantics and arrival timestamp behavior.
   - Assert malformed, non-data, and incomplete envelopes emit nothing, followed by a valid envelope that still emits.
   - Assert error/exit/close-equivalent terminal callbacks emit one immediate invalidation and schedule one restart.
   - Assert retry delays are 1/2/4/8 seconds, stay capped at 8 seconds, and reset after a valid snapshot.
   - Assert two `createSystemMedia()` backends retain independent sampled and transport-mutated clocks.
   - Assert disposal kills the source, cancels retry work, is safe when repeated, and suppresses late snapshots and invalidations.
   - Preserve coverage that `nowplaying-cli` omits `subscribe` and returns normalized polled state.

10. Update `packages/music-core/README.md`.
   - Document backend-owned playback clocks and the public explicit clock API.
   - Document both subscription event variants and show safe discriminated handling.
   - State that media-control snapshots are already normalized and authoritative, while invalidation asks a host to recover by sampling.
   - State that `nowplaying-cli` remains polling-only.
   - Document disposer ownership and suppression of late callbacks.
   - Remove wording that says every stream event is only an invalidation or always requires `player()`.

## Acceptance Checks

- A complete stream payload with `playing: false` emits an authoritative paused `PlayerState` before any explicit provider sample and without invoking `player()`.
- Explicit `player()` output and complete stream payloads pass through one media-control decoder and produce equivalent normalized state.
- The emitted snapshot uses one arrival timestamp for clock reconciliation and `fetched_at`.
- Two backend instances can sample and control different tracks without changing each other's clock, position, or play state.
- Idle, next, and previous reset only the owning backend clock.
- Error, exit, and close notifications from one stream generation produce exactly one immediate invalidation and one restart timer.
- Consecutive stream failures use capped 1/2/4/8-second restart delays, and a valid snapshot resets the delay.
- Malformed, non-data, and incomplete stream envelopes emit nothing and do not block a later valid snapshot.
- `nowplaying-cli` still omits `subscribe` and returns normalized polled state.
- Repeated disposal kills the active stream at most once, cancels pending retry work, and suppresses all late events.
- Existing play, pause, seek, next, previous, fallback, error, normalization, and package exports remain valid except for documented explicit clock API changes.

## Verify Commands

Run from the repository root:

```sh
bunx nx run-many -t typecheck test format:check package:check --projects=music-core
```

The phase is complete only when every target passes.

## Non-Goals

- OpenCode or Pi host-controller scheduling and event consumption
- Transport intent queues, seek coalescing, busy-latch removal, or host promise semantics
- Artwork lookup, download, conversion, caching, completion events, or Kitty rendering
- Stream support for `nowplaying-cli`
- UI changes, polling cadence changes in either host, or host lifecycle refactors
- Backward compatibility through a hidden module-global playback clock
- Modifying, force-pushing, or adding commits to PR #40
