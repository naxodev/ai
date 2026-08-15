---
status: done
---

# Phase 1 package: provider attempt lifecycle and bounded event bridge

## Intent

Finish only the daemon’s provider boundary in the existing dirty worktree. Make one raw provider attempt, callback-to-Effect event delivery, retry timing, tagged provider failures, and provider/source cleanup independently correct and deterministically tested.

Do not fix coordinator authority, socket cleanup, protocol/client behavior, daemon startup, host migration, artwork, packaging, or docs in this phase. In particular, the abandoned review’s coordinator and server findings belong to Phases 2 and 3 and are not acceptance gates here.

Preserve all accumulated work, including `docs/music-session-architecture.html`, and refine the existing implementation rather than resetting it. Use Effect TypeScript v4 only.

## Files to touch

Only these product/test files:

- `packages/music-core/system-media.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/tests/system-media.test.ts`

Do not create a parallel provider module or another package. Keep the low-level one-attempt seam in `system-media.ts`, the Effect ownership/retry boundary in `session/provider.ts`, and focused evidence in the existing `system-media.test.ts`.

## Files not to touch

- `packages/music-core/session/config.ts`
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/session/framing.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/index.ts`
- `packages/music-core/tests/session-coordinator.test.ts`
- `packages/music-core/tests/session-protocol.test.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`
- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/scripts/verify-pack.ts`
- `packages/music-core/tsconfig.json`
- `bun.lock`
- Anything under `packages/opencode-music-player/`
- Anything under `packages/pi-music-dock/`
- `README.md`, package READMEs, and `docs/music-session-architecture.html`
- `.apnea/state.json` and other `.apnea` tasks/artifacts

If the implementation appears to require one of these paths, stop rather than broadening Phase 1.

## Required behavioral shape

### Ownership boundary

- `system-media.ts` owns platform decoding, one shared playback clock, sample/transport operations, and a raw **single-attempt** callback seam.
- `session/provider.ts` owns Effect acquisition, bounded callback bridging, attempt supervision, retry timing, tagged provider errors, and scoped interruption.
- The callback seam may only publish data/terminal notifications into bounded bridge state. It must not start Effect work, launch detached Promise work, or own retry timing.
- Production `createSystemMedia()` remains compatible for the still-unmigrated hosts. Its existing legacy callback/timer supervision is allowed to remain in `system-media.ts`; the daemon path must use `subscribeAttempt`, not `subscribe`.

### Event guarantees

The provider stream has two different event guarantees and must not put them in one lossy mixed sliding queue:

1. Complete snapshots may be conflated under pressure, but the latest complete snapshot for an attempt must remain deliverable.
2. Every attempt terminal transition must schedule exactly one invalidation and must not be evicted by snapshots.

Use separate bounded state/signals for these concerns. There can be only one active attempt, and retry must not begin until that attempt’s terminal invalidation has been handed to the bounded Effect-owned output path. This provides backpressure for terminals and keeps the number of pending terminal signals bounded. A capacity-one conflated snapshot slot/wakeup is sufficient; an unbounded queue is not.

If terminal arrives while the downstream consumer is blocked, eventual delivery must preserve the latest pending snapshot and one terminal invalidation. Late callbacks from the disposed attempt must be ignored.

## Exact implementation steps

### 1. Preserve and harden the one-attempt system-media seam

In `packages/music-core/system-media.ts`:

1. Keep `createSystemMediaAdapter()` as one adapter with one `PlaybackClock` shared by:
   - `player()` sampling;
   - successful play/pause/seek/next/previous clock changes;
   - complete `media-control stream` snapshot decoding.
2. Keep `SystemMediaAttemptAdapter.subscribeAttempt` as the daemon-only unsupervised seam. One call must start exactly one:

   ```text
   media-control stream --no-diff --no-artwork
   ```

3. Do not add retry timers to this seam. It emits only:
   - decoded complete `snapshot` events; and
   - one `invalidation` when that attempt terminates.
4. Preserve complete-payload validation. Partial/diff/malformed lines must not become authoritative snapshots.
5. Make disposal idempotent for all orderings:
   - explicit dispose before terminal;
   - terminal before explicit dispose;
   - duplicate terminal callback;
   - terminal called synchronously before `startLineStream` returns its disposer;
   - late line/terminal callbacks after disposal.
6. Ensure the raw source disposer runs exactly once in every ordering above.
7. Do not alter the legacy `createSystemMedia().subscribe` contract, its 1/2/4/8 retry behavior, backend fallback, command behavior, or public types used by OpenCode/Pi.

### 2. Make provider acquisition and operations tagged boundaries

In `packages/music-core/session/provider.ts`:

1. Retain `SessionProvider` as the Effect service and `ProviderError` as a `Schema.TaggedErrorClass` carrying at least operation, message, and original defect/cause.
2. Factor adapter-to-service construction so production and tests exercise the same implementation. A small scoped test constructor in this existing file is acceptable; do not create another module.
3. Acquire `createSystemMediaAdapter()` with `Effect.try`/equivalent typed acquisition, not `Effect.sync`. A synchronous adapter creation failure must become `ProviderError` with an acquisition operation.
4. Wrap every external synchronous or Promise boundary once:
   - provider status/probes;
   - sample;
   - transport;
   - `subscribeAttempt` startup;
   - source disposal when it can throw.
5. Give source startup/acquisition a stable operation such as `source` or `subscribe`; use it consistently in tests. Do not catch genuine Effect interruption and convert it into `ProviderError`.
6. Unsupported transport remains a typed provider failure. A provider operation failure must not be wrapped repeatedly or lose its original cause.
7. Register scoped exact-once finalization for the adapter/service lifetime and active source. The test constructor must expose enough acquisition/finalization instrumentation to prove this without changing production callers.

### 3. Replace the mixed sliding bridge

Replace the current `Stream.callback(..., { strategy: "sliding" })` design in `eventsFromAttemptAdapter`.

1. Build the stream from scoped, bounded Effect primitives, for example:
   - one capacity-one conflated snapshot slot/wakeup;
   - one dedicated terminal signal for the current attempt;
   - one bounded downstream event queue;
   - one scoped attempt-supervisor fiber.
2. Callback work must be constant and non-blocking: update/offer only into the private bounded bridge and return.
3. Snapshot pressure may replace an older pending snapshot with a newer one. It must not replace a terminal signal.
4. A terminal signal must:
   - be accepted once for that attempt;
   - stop/dispose that attempt once;
   - retain/drain the latest pending complete snapshot as applicable;
   - enqueue one invalidation without waiting for a recovery sample;
   - only then enter retry pacing.
5. Do not begin another attempt while the prior terminal invalidation is merely pending outside the bounded output path. This is what makes “one invalidation per terminal” compatible with bounded memory.
6. Acquisition failure has no callback terminal, so normalize it at the same supervision boundary: retain the tagged `ProviderError`, publish the provider invalidation/degradation signal expected by this stream, and continue through the retry schedule rather than terminating the worker permanently.
7. Closing the stream scope must interrupt the active attempt or retry sleep, shut down bridge queues, dispose the active source once, and suppress all late callback offers.
8. Do not use an unbounded queue, a raw timer, a detached Promise loop, `Effect.runSync`, or `Effect.runPromise` inside the provider implementation.

### 4. Keep retry state owned by the Effect supervisor

1. Use Effect `Schedule`/Effect clock for delays of 1, 2, 4, 8, 8 seconds on consecutive unsuccessful attempts.
2. A valid complete snapshot in an attempt resets the **next** terminal/startup-failure retry delay to one second.
3. Multiple snapshots in one attempt cause one reset; reset tokens must not leak into later attempts.
4. A terminal emits its invalidation before sleeping.
5. Attempt startup failures participate in the same capped progression and do not kill the event stream.
6. Interruption during an active attempt or any retry wait prevents another attempt from starting.
7. Prefer keeping retry accounting private to the supervisor. Retain `attemptRetrySchedule` as an export only if it remains useful to the integrated behavior; do not let a schedule-only unit test substitute for end-to-end stream evidence.

### 5. Replace weak timing coordination with deterministic test controls

In `packages/music-core/tests/system-media.test.ts`:

1. Extend the existing stream fake instead of creating another test file. Add deterministic controls/counters for:
   - attempt-start notification;
   - synchronous startup failure;
   - emitted complete snapshots and terminals;
   - source disposal;
   - adapter/service acquisition and finalization where the provider test constructor needs them.
2. Use `Deferred`, bounded `Queue`, `Ref`, `Latch`, and `TestClock` to coordinate tests. Do not use wall-clock sleeps or arbitrary repeated `Effect.yieldNow` loops as proof that a fiber probably started.
3. Preserve all existing legacy tests below the one-attempt section. Update focused tests where the provider architecture changes, but do not weaken existing expectations.

Add or strengthen focused tests for all of the following:

#### One-attempt seam

- It starts one raw source and creates no retry timer.
- Complete input emits a snapshot; partial/malformed input does not.
- Duplicate terminal calls emit one invalidation and dispose once.
- Explicit dispose, synchronous terminal-before-return, and late callbacks each remain exact-once and silent after disposal.
- Sampling, stream decoding, and transport still share one adapter clock.

#### Bounded bridge

- Block the downstream consumer, emit more snapshots than the bridge capacity, then terminate the attempt. After release, the newest snapshot and exactly one invalidation are observed.
- Snapshot bursts do not grow an unbounded collection; assert the configured bridge bound through observable counters/state rather than process memory.
- A terminal cannot be evicted by later snapshots, and a snapshot cannot erase the terminal signal.
- Duplicate/late terminal callbacks do not create duplicate invalidations.

#### Retry and errors

- Integrated `eventsFromAttemptAdapter` behavior under `TestClock` starts attempts after 1/2/4/8/8 seconds.
- A valid snapshot followed by terminal resets the very next delay to one second.
- A synchronous `subscribeAttempt` throw is a `ProviderError` at the source operation and supervision still starts the next attempt on schedule.
- Status/probe, sample, unsupported transport, transport rejection, and adapter acquisition failures retain their expected `ProviderError` operation/cause.
- A failed attempt does not permanently terminate event supervision.

#### Scope cleanup

- Interrupting during retry sleep starts no later attempt.
- Interrupting an active attempt disposes its source once and suppresses late snapshot/terminal callbacks.
- Closing the provider Layer finalizes adapter/provider/source ownership exactly once, including repeated/competing cleanup paths.
- No focused test leaves a fiber, queue, callback, source, or retry sleeper alive.

## Acceptance checks

All checks below must be true before handing off Phase 1:

- One provider Layer acquisition creates one adapter and at most one active raw source attempt.
- The one-attempt seam owns no retry timer and uses the same adapter clock as sample and transport.
- Complete snapshots are authoritative; malformed/partial provider payloads remain ignored.
- The callback bridge is bounded, conflates snapshots toward the latest value, and guarantees one invalidation for every terminal transition. It is not one lossy mixed queue.
- Synchronous attempt startup failure is a tagged `ProviderError` and cannot permanently kill supervision.
- Sample, transport, status/probe, adapter acquisition, source startup, and source disposal failures cross one tagged provider boundary; interruption remains interruption.
- `TestClock` proves integrated 1/2/4/8/8 retries and reset to one second immediately after a valid snapshot.
- Interruption during active attempt or retry wait prevents restart, disposes exactly once, and ignores late callbacks.
- Existing `createSystemMedia()` fallback, clock, complete-stream-payload, command, and legacy retry behavior remains green.
- No coordinator, server, protocol, client, host, documentation, manifest, lockfile, or `.apnea/state.json` change is included.

## Verify commands

Run from the repository root in this order:

```sh
bun test packages/music-core/tests/system-media.test.ts
bunx nx run-many -t typecheck test format:check package:check --projects=music-core
! rg -n "Effect\.runSync|Effect\.runPromise|setTimeout\(|setInterval\(" packages/music-core/session/provider.ts
jj diff --summary
```

Inspect the final `jj diff --summary` rather than cleaning the working copy. It must show the preserved pre-existing migration and architecture HTML plus Phase 1 changes only in the three allowed product/test paths (apart from this run’s `.apnea` artifacts). Do not reset unrelated changes.

Use the run’s Jujutsu squash workflow only after review approval: keep implementation in the current phase child for review, do not create a Git commit or push, and let the approved phase be squashed into the accumulated run change before Phase 2 begins.

## Dependencies

- Existing `packages/music-core/system-media.ts` provider normalization, backend fallback, legacy stream retry, and playback clock behavior.
- Existing `packages/music-core/session/provider.ts` service attempt.
- Existing focused test fakes in `packages/music-core/tests/system-media.test.ts`.
- Pinned `effect@4.0.0-beta.101`, including `effect/testing` `TestClock`.

## Non-goals

- Fixing coordinator optimistic projection, sampling generations, polling deadlines, reconciliation, command queue, or coordinator tests.
- Fixing listener/socket/connection ownership, close/unlink reporting, signal cleanup, or server tests.
- Changing schemas, wire revision negotiation, capabilities, framing, client correlation, or disconnect semantics.
- Runtime-directory discovery, singleton launch, reconnect, idle exit, diagnostics, or 24-client load/backpressure.
- Native artwork requests or deduplication.
- OpenCode or Pi migration and removal of host-owned polling/provider work.
- Package manifest, export, bin, pack verifier, smoke, README, or architecture HTML changes.
- Publishing, committing, pushing, opening a PR, editing `.apnea/state.json`, or deleting unrelated worktree content.
