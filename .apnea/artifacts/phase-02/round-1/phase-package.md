---
status: done
---

# Phase 2 package: coordinator atomic authority, polling, reconciliation, and global commands

## Intent

Make `MusicSessionCoordinator` the sole atomic authority for daemon state, samples, polling deadlines, reconciliation, and globally ordered transport commands. Prove this seam with an Effect-native fake provider Layer and deterministic Effect synchronization/time.

This phase does not require a Unix listener, protocol/client change, process lifecycle, or host migration. Do not use `session-server.test.ts` as acceptance evidence. Phase 1’s provider stream is approved and is a dependency; preserve its bounded, shared, scoped behavior.

Preserve the current dirty worktree and `docs/music-session-architecture.html`. Refine the accumulated coordinator/config implementation in place. Use Effect TypeScript v4 only.

## Files to touch

Only these files:

- `packages/music-core/session/config.ts`
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/tests/session-coordinator.test.ts`

`provider.ts` may change only to add/rework the Effect-native coordinator test Layer and its controls. Do not alter the approved production attempt lifecycle, shared event stream, bounded bridge, retry schedule, or provider error behavior from Phase 1.

## Files not to touch

- `packages/music-core/system-media.ts`
- `packages/music-core/session/framing.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/index.ts`
- `packages/music-core/tests/system-media.test.ts`
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

If work appears to require a socket, wire, client, host, manifest, or documentation change, stop rather than broadening Phase 2.

## Required coordinator invariants

The implementation must maintain all of these invariants inside one Effect scope:

1. **One authority token:** every accepted snapshot, accepted sample, successful optimistic command projection, and successful navigation authority advance changes one monotonic revision.
2. **Atomic projection:** a command never republishes an entire state captured before a concurrent provider snapshot. Play/pause/seek transform the state that is current at the atomic commit.
3. **Single-flight sample:** at most one provider sample runs. A trigger arriving while it runs immediately makes that result stale and coalesces all overlap into one follow-up sample.
4. **Stale-result rejection:** a sample started before a newer trigger, complete snapshot, or successful command cannot publish.
5. **One poll deadline:** each authoritative state revision owns at most one deadline selected from 3/5/8 seconds. A stale install cannot replace a newer revision’s deadline.
6. **One command lane:** all submitters enter one bounded FIFO. `toggle` resolves from authoritative state when dequeued, not when submitted.
7. **Exact-once settlement:** success, provider failure, queue overflow, and scope closure settle each caller exactly once. Closing the scope cannot lose a caller between enrollment and queue offer.
8. **Scoped work:** event consumption, command worker, sampling, polling, reconciliation, and recovery are supervised Effect fibers/effects. No raw timer, detached Promise loop, or isolated runtime call owns work.

## Exact implementation steps

### 1. Complete the Config service boundary

In `packages/music-core/session/config.ts`:

1. Keep `MusicSessionConfig` as the single `Context.Service` containing one validated `ResolvedMusicSessionOptions`.
2. Keep the existing defaults:
   - maximum frame bytes: 64 KiB;
   - command capacity: 128;
   - transport reconciliation: 120 ms;
   - navigation reconciliation: 150 ms;
   - playing poll: 3 seconds;
   - paused-with-track poll: 5 seconds;
   - idle poll: 8 seconds.
3. Make concrete options and `ConfigProvider`-backed acquisition use one validation function. Defaults apply only when a value is absent.
4. Reject an empty socket path and every non-number, non-finite, non-integer, unsafe, zero, or negative frame/capacity/timing value as `MusicSessionConfigError` with stable `setting`, `operation`, and useful `message`.
5. Do not read `process.argv` or `process.env` directly in coordinator/config application logic. Effect `Config` recipes own runtime reads.
6. Keep any Promise compatibility helper as an outer facade only; coordinator construction must consume the Layer-provided service.
7. Add deterministic tests in `session-coordinator.test.ts` for defaults, concrete overrides, equivalent config-provider values, missing/defaulted values, malformed numeric text, and invalid values for each setting family.

### 2. Add an Effect-native fake provider Layer

In `packages/music-core/session/provider.ts`, replace coordinator tests’ dependence on `createFakeProvider`/`layerFromLegacy` with a reusable Effect-native test fixture. Keep the legacy fake for Phase 3 socket compatibility if it is still needed elsewhere.

The fixture should return a `SessionProvider` Layer plus test controls implemented with Effect primitives. It must provide:

- current status and sample state;
- a scoped event source that can emit complete snapshots and invalidations deterministically;
- `Deferred`/`Latch` controls to block and release sample or transport calls;
- controls to fail or return `null` from the next sample;
- a control to fail the next transport;
- an ordered transport-call record including action and seek position;
- sample-start and transport-start signals, so tests never guess with repeated yields;
- counters for active/max-concurrent samples, completed/interrupted samples, active/max-concurrent transports, event subscriptions, and finalization;
- exact-once Layer/source finalization and suppression of late test emissions after scope closure.

Provider operations in this fixture must be native `Effect`s, not Promises hidden behind `Effect.tryPromise`. Do not add test-only controls to the public `SessionProvider` service interface.

### 3. Centralize revisioned state transitions

In `packages/music-core/session/coordinator.ts`:

1. Keep provider status and revisioned player state in `SubscriptionRef`s. Expose `SubscriptionRef.changes` so a new subscriber receives the current value before later updates.
2. Replace ad hoc state writes with a small set of named atomic transitions:
   - replace with a complete provider snapshot;
   - merge an accepted sampled state using `mergePlayer`;
   - project a successful play/pause/seek over the state current at commit;
   - advance authority after next/previous without inventing metadata.
3. Every successful transition increments the daemon revision exactly once and returns enough committed revision/state information to install the matching poll deadline.
4. A no-op/invalid merge does not increment revision.
5. Use Effect clock time for optimistic `fetched_at`; do not call `Date.now()` in coordinator work.
6. Keep daemon instance identity stable for the scope. Instance-ID generation itself may remain an outer value concern; revision/state authority may not depend on mutable process globals.

### 4. Fix optimistic command projection atomically

The current worker reads `stateRef`, awaits transport, reads state again, constructs a full object outside the atomic update, and calls `accept`. Replace that pattern.

1. After provider transport succeeds, call one `SubscriptionRef.modify`-based projection that receives the state current at commit time.
2. For play/pause, alter only `is_playing` and `fetched_at` on that current state.
3. For seek, alter only `progress_ms` and `fetched_at`, clamping to the current track duration when a positive duration exists.
4. If a complete provider snapshot lands after transport starts but before projection commits, preserve its track, device, metadata, and unrelated playback fields.
5. For next/previous, increment authority and preserve current state until reconciliation/snapshot supplies replacement metadata.
6. Settle command success after the authoritative transition has committed, then schedule reconciliation. The client must never observe command success before central projection/authority advance.

Add a deterministic race test: block transport, publish a provider snapshot with different track/device/progress, release transport, and assert the successful projection changes only its intended field on the newer snapshot.

### 5. Make the sampling lane atomic and coalesced

1. Keep one explicit sampling state containing active ownership, pending catch-up, and generation/ticket.
2. Serialize trigger invalidation with the sample’s final stale check and state commit. There must be no window where a trigger arrives after stale validation but before publication.
3. A trigger while idle claims the lane and starts one sample. A trigger while active:
   - advances/stales the active generation immediately;
   - sets one pending catch-up flag;
   - does not fork another concurrent sample.
4. At completion, commit only if both its ticket and starting authority revision remain current.
5. Transfer ownership directly to one coalesced catch-up before exposing the lane as idle; triggers cannot be lost in a completion/next-claim gap.
6. Provider sample failure degrades status as currently intended, requests/retains recovery as appropriate, and does not kill event/poll workers.
7. A `null`/unmergeable result publishes no state but leaves a valid next polling deadline.
8. Complete snapshots and successful commands invalidate older samples through the same authority token.
9. Scope interruption cancels the active sample and drops pending catch-up work.

Use test controls to prove max concurrent samples is one and remove repeated `Effect.yieldNow` polling from the coordinator race tests.

### 6. Own polling and reconciliation with Effect time

1. Select poll delay from the committed state:
   - playing: 3 seconds;
   - paused with a track: 5 seconds;
   - idle/no track: 8 seconds.
2. Maintain one revision-tagged poll deadline. Installing a newer deadline atomically replaces and interrupts the previous one. A delayed older installation must interrupt itself rather than replace a newer deadline.
3. A complete snapshot, accepted sample, or successful command projection/authority advance resets the deadline from that update’s committed state/revision.
4. Avoid an unbounded poll-trigger queue. Use a capacity-one/coalescing signal or equivalent ownership so repeated deadline/restart activity cannot accumulate unbounded triggers.
5. Poll failure, `null`, or stale rejection still installs the next deadline based on current authoritative state.
6. Reconcile play/pause/seek after configured transport delay and next/previous after configured navigation delay using Effect clock/Schedule.
7. Multiple reconciliation/sample triggers may coalesce through the single sampling lane; they may not create concurrent provider samples.
8. Scope closure interrupts poll and reconciliation sleepers, and late clock advances do nothing.

Add `TestClock` evidence at boundaries: no action at one millisecond before each delay, exactly one trigger at the delay, and no duplicate trigger afterward. Test all 3/5/8 poll modes, deadline reset after an authoritative update, transport delay, navigation delay, and closure during a reconciliation wait.

### 7. Keep one bounded global command queue

1. Keep one bounded Effect `Queue<Job>` and one scoped worker.
2. Enroll a job in the lifecycle registry before offering it. Queue offer, overflow, queue shutdown, fast worker completion, and scope close must not leave a registered caller unresolved.
3. Resolve `toggle` only after dequeuing from the authoritative current state. Two queued toggles from paused state must invoke provider play then pause.
4. Preserve FIFO across concurrent submitters for all transport actions.
5. On success:
   - commit optimistic projection/authority atomically;
   - settle the caller once;
   - schedule reconciliation.
6. On provider failure:
   - fail that caller with schema-tagged `SessionCommandError` code `PROVIDER_FAILURE`, operation, message, and provider cause;
   - request one recovery sample through the single-flight lane;
   - keep the worker alive for the next queued command.
7. On full queue, fail only that submission with tagged `SERVER_BUSY`; do not grow another pending collection without the same bound. The active job plus configured queue capacity is the explicit upper bound.
8. On scope closure, atomically mark closed, shut down the queue, interrupt active transport/reconciliation, and fail every active/queued registered caller once with tagged `DISPOSED`.
9. Submission after closure fails immediately as `DISPOSED`.
10. Do not convert interruption or defects into `PROVIDER_FAILURE`.

### 8. Keep internal failures schema-tagged

1. Retain or refine `SessionCommandError` as `Schema.TaggedErrorClass`; do not replace it with a conventional `Error` subclass.
2. Preserve stable boundary codes `SERVER_BUSY`, `DISPOSED`, and `PROVIDER_FAILURE` for the later server adapter.
3. Include operation/message and provider cause where applicable.
4. Catch only expected typed provider failures. Interruption must unwind scope work; defects must remain defects.
5. Status degradation caused by a sample failure must not expose/log playback payloads.

### 9. Rewrite focused tests around deterministic controls

In `packages/music-core/tests/session-coordinator.test.ts`:

1. Use `Effect.runPromise` only as the Bun-test boundary. Inside tests use scoped Effects, the Effect-native fake Layer, `Deferred`, `Queue`, `Ref`, `Latch`, `Fiber`, and `TestClock`.
2. Remove arbitrary `Effect.repeat(Effect.yieldNow, ...)` loops and Promise gates from coordinator acceptance evidence. Wait for explicit fake-provider start/commit signals.
3. Do not instantiate a server/client or open a Unix socket.
4. Preserve useful existing behavioral tests but rewrite them against the native fake.

The focused suite must directly prove:

- config defaults, concrete/config-provider parity, and typed invalid settings;
- status and state current-value replay for late subscribers;
- immediate complete snapshot publication with no extra sample;
- invalidation burst: one stale active sample plus one catch-up, maximum concurrency one;
- pre-snapshot, pre-trigger, and pre-command sample rejection;
- snapshot-vs-play, snapshot-vs-pause, and snapshot-vs-seek projection preserve newer metadata;
- playing/paused/idle polling at 3/5/8 seconds and deadline reset;
- stale poll-deadline installation cannot replace a newer one;
- transport and navigation reconciliation at their distinct configured delays;
- play/pause/seek optimistic publication before reconciliation;
- multi-submitter FIFO and dequeue-time alternating toggles;
- provider transport failure is tagged, requests recovery, and does not stop the next job;
- configured queue saturation returns `SERVER_BUSY` without unbounded growth;
- close racing enrollment/offer, blocked sample, blocked active transport, queued transports, poll sleep, and reconciliation sleep settles/interrupts exactly once;
- late release/emission/clock adjustment after closure cannot publish or execute more work;
- fake provider event subscription and Layer finalization occur exactly once.

## Acceptance checks

All checks must pass before handing off Phase 2:

- The coordinator is the only state revision, polling, reconciliation, sampling, and command authority.
- `SubscriptionRef` streams replay current status/state to late subscribers.
- Complete snapshots publish immediately. Trigger bursts produce one stale discarded sample and one catch-up with maximum sample concurrency one.
- Samples started before a newer trigger, snapshot, or successful command cannot publish.
- Play/pause/seek atomically transform the state current at commit and cannot roll back a newer snapshot’s metadata; next/previous advance authority without invented state.
- `TestClock` proves 3/5/8 polling, reset/replacement semantics, transport/navigation reconciliation, and interruption of pending deadlines.
- One bounded FIFO handles all submitters; toggles resolve at dequeue time; queue saturation and provider failure do not kill the worker.
- Every command caller settles exactly once on success, failure, overflow, or closure; no close/enrollment race strands a caller.
- Config and command/provider boundary failures are schema-tagged; interruption/defects are not mislabeled.
- Coordinator tests use an Effect-native fake Layer and deterministic signals, not Promise/callback fakes, arbitrary yields, wall-clock sleeps, sockets, or later-phase behavior.
- Phase 1 provider tests and the full music-core package gate remain green.
- Changes are confined to the four allowed product/test files, apart from this run’s `.apnea` artifacts; unrelated dirty work and `.apnea/state.json` remain untouched.

## Verify commands

Run from the repository root in this order:

```sh
bun test packages/music-core/tests/session-coordinator.test.ts
bun test packages/music-core/tests/system-media.test.ts
bunx nx run-many -t typecheck test format:check package:check --projects=music-core
! rg -n "Effect\.runSync|setTimeout\(|setInterval\(|Date\.now\(" packages/music-core/session/coordinator.ts
! rg -n "createFakeProvider|layerFromLegacy|Effect\.repeat\(Effect\.yieldNow|new Promise" packages/music-core/tests/session-coordinator.test.ts
jj diff --summary
```

The second focused command is a Phase 1 regression gate, not new Phase 2 acceptance evidence. Inspect `jj diff --summary`; do not clean/reset the worktree. Product/test changes introduced by this phase must remain within the four allowed paths while all pre-existing migration and `docs/music-session-architecture.html` changes remain present.

Keep implementation in the current Jujutsu phase child for review. Do not run `git commit`, push, or manually rewrite history. After approval, follow the run’s `jj squash` workflow to fold the accepted Phase 2 child into the accumulated run change before Phase 3 starts.

## Dependencies

- Approved Phase 1 `SessionProvider` service, shared bounded event stream, tagged provider errors, scoped attempt ownership, and deterministic provider tests.
- Existing `mergePlayer` reconciliation behavior and `RevisionedState`/transport types.
- Pinned `effect@4.0.0-beta.101`, including `effect/testing` `TestClock`.

## Non-goals

- Unix listener acquisition, accepted socket ownership, framing, close/unlink error reporting, signal handling, or server cleanup tests.
- Protocol schema expansion, revision-range/capability negotiation, frame hardening, or explicit client changes.
- Runtime-directory discovery, singleton launch, reconnect, idle daemon exit, diagnostics, slow-reader bounds, or 24-client operation.
- Native artwork request/caching/deduplication.
- OpenCode or Pi client/controller migration, UI behavior, waveform, notifications, or host cleanup.
- Manifest, exports, bin, pack verifier, smoke, README, or architecture HTML changes.
- Publishing, committing, pushing, opening a PR, editing `.apnea/state.json`, or removing unrelated worktree content.
