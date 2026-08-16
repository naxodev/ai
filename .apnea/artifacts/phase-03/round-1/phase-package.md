---
status: done
---

# Phase 3 package: deterministic startup pacing, convergence, marker release, and skew races

## Intent

Finish only the managed startup acceptance matrix on top of the approved selected graph and separate-process singleton proof.

This phase covers four boundaries:

1. the real startup retry workflow is paced and capped by Effect `Schedule` under `TestClock`;
2. twenty simultaneous `connectOrStart` callers converge through real discovery, leases, listener, and hello on one daemon/provider owner;
3. the exact owned startup marker is released on every workflow exit, with primary and release failures reported truthfully;
4. incompatibility before acquisition, after acquisition, and while waiting is terminal for the observed healthy generation and never causes replacement behavior.

Returned clients remain single-generation clients. Live-loss reconnect belongs to Phase 4. Treat Phase 1 graph shutdown/readiness and Phase 2 process contention as baseline regressions only.

Use repository-pinned Effect v4 `Effect`, `Schedule`, `TestClock`, fibers, scopes/finalization, `Ref`, and deterministic test services. Do not use raw timers, `Bun.sleep`, polling loops, or detached Promise retry work.

## Files to touch

Only as required:

- `packages/music-core/session/config.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts` only if a shared existing server observation must be adjusted for the 20-client integration proof

Prefer keeping all new Phase 3 evidence in `session-client.test.ts`.

## Files not to touch

- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/framing.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/system-media.ts`
- `packages/music-core/index.ts`
- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/tests/session-protocol.test.ts`
- `packages/music-core/tests/session-coordinator.test.ts`
- `packages/music-core/tests/system-media.test.ts`
- Anything under `packages/opencode-music-player/` or `packages/pi-music-dock/`
- `README.md`, package READMEs, and `docs/music-session-architecture.html`
- `.apnea/state.json` and unrelated `.apnea` tasks/artifacts

Do not create a new source or test module. Do not change protocol ranges/capabilities to manufacture skew; use the existing `protocolRange` option and negotiated incompatibility response.

## Exact implementation steps

### 1. Preserve the approved singleton baseline

1. Inspect the current tree and retain approved Phase 1 change `08acaab5` and Phase 2 change `73a988d6` unchanged.
2. Retain secure runtime inspection, opaque lease-backed discovery authority, exact inode/token marker release, detached launch options, listener-first bind gating, crash-safe bind reservation, and same/separate-process tests.
3. Do not reset, clean, or recreate accumulated startup code. Refactor only where required to make its current behavior deterministic, observable, and correct under this phase's acceptance.

### 2. Give the Effect startup workflow a narrow deterministic test seam

In `packages/music-core/session/client.ts`:

1. Keep `connectOrStartMusicSessionEffect` as the authoritative workflow and `connectOrStartMusicSession`/`connectOrStart` as thin Promise adapters. Do not create a second test-only startup algorithm.
2. If needed, add a narrow second-argument dependency object to the Effect function for boundary substitution in deterministic tests. Production defaults must remain the existing functions:
   - one-attempt `discoverMusicSession`;
   - `acquireStartupMarkerLease`;
   - the selected launcher;
   - release-failure reporting/observation.
3. Keep the Promise adapters on production dependencies and the existing launcher option. Do not expose filesystem cleanup, socket unlink, process kill, or arbitrary marker authority through this seam.
4. Permit tests to observe attempt start and release failure without changing control flow. Observation callbacks must be synchronous/bounded and ignored if they throw, like existing lifecycle hooks.
5. Keep `StartupPending` internal. Only it may continue the schedule. Incompatibility, occupied/unsafe artifacts, config defects, spawn failures, and release-only failures are terminal.

### 3. Make one bounded schedule own every pending transition

In `packages/music-core/session/client.ts`:

1. Retain validated `attempts`, `initialDelayMs`, and `maxDelayMs` from `resolveMusicSessionStartup`; do not read environment variables in workflow logic.
2. Use one Effect `Schedule` for the complete retry loop. Every `StartupPending` transition—live foreign marker, lease contention, stale cleanup followed by reprobe, newly acquired lease before post-acquisition probe, and successful spawn before hello—must pass through that schedule.
3. Preserve production jitter and cap the final jittered delay at `maxDelayMs`. Attempts must be finite; `attempts` means the total number of discovery attempts, including the initial immediate attempt.
4. A healthy hello returns immediately. Terminal errors must not consume another delay or probe.
5. Schedule exhaustion must fail once with tagged `MusicSessionStartupError` operation `timeout` and must then finalize any owned marker.
6. Interruption must cancel the scheduled sleep and prevent all later discovery/launch attempts while still running marker finalization uninterruptibly.
7. Do not use `Date.now`, `setTimeout`, `setInterval`, `Bun.sleep`, Promise polling, or recursive detached tasks for startup timing.

In `packages/music-core/tests/session-client.test.ts`, test the real schedule with `TestClock` and deterministic Effect random/test services:

1. Script discovery outcomes only at the discovery boundary; run the production retry loop and schedule.
2. Fork the workflow and assert the first attempt is immediate.
3. Advance virtual time to just before the next delay and prove no attempt occurs; advance through it and prove exactly one next attempt.
4. Record virtual attempt times and prove positive pacing, exponential progression subject to jitter, and a final delay no greater than `maxDelayMs`.
5. Prove success before exhaustion returns the scripted client/outcome with no extra attempt.
6. Prove perpetual pending stops at exactly the configured attempt count and returns the typed timeout.
7. Interrupt a sleeping workflow, advance `TestClock` far beyond the full schedule, and prove no additional attempt or launch occurs.

### 4. Make marker finalization truthful on every exit

Refactor finalization around `connectOrStartMusicSessionEffect` as needed:

1. Record a lease immediately and uninterruptibly once exclusive acquisition succeeds. Interruption cannot occur between acquisition and ownership registration.
2. Release at most the exact recorded lease. Never call path-based cleanup as a substitute and never remove a replacement marker.
3. Run release once, uninterruptibly, after:
   - successful compatible hello;
   - timeout;
   - workflow interruption;
   - synchronous or initial launcher failure propagated through the whole workflow;
   - occupied/unsafe/config/terminal protocol failure after acquisition;
   - defects in post-acquisition discovery.
4. Preserve primary outcome semantics:
   - primary failure + release failure returns the original primary failure and separately reports the typed release failure;
   - interruption + release failure remains interruption and reports release failure;
   - success + release failure disposes the newly returned client and surfaces the release failure rather than claiming clean startup.
5. Production reporting may use Effect structured logging, but tests must have a narrow observer proving the secondary release diagnostic is retained. Do not log playback data, marker tokens, or complete environment values.
6. Keep `StartupMarkerLease.release()` idempotent and exact-owner guarded. Existing replacement-marker evidence remains green.

Add focused workflow tests using real secure temporary runtime directories:

1. Successful startup removes the one owned marker.
2. TestClock timeout removes it.
3. Fiber interruption after acquisition removes it and schedules no more work.
4. A launcher rejection through the complete `connectOrStart` workflow removes it and spawns only once.
5. Inject release failure: assert a primary spawn/timeout error remains primary, the release error is observed separately, and the marker is left for failure-safe test cleanup.
6. Replace the marker inode/token before release and prove it remains untouched; retain the existing lease-level replacement test as baseline.
7. Put all clients, leases, server facades, fibers, gates, and temporary directories in unconditional `finally`/scoped cleanup.

### 5. Prove 20 concurrent callers converge through real topology

In `packages/music-core/tests/session-client.test.ts`:

1. Create one real secure temporary managed runtime and one instrumented `createFakeProvider`.
2. Inject only the process-launch boundary. Its first invocation starts `startMusicSessionServer({ runtime }, provider, hooks)` using the approved selected graph and real Unix listener. Discovery, marker acquisition, bind, hello, and client sockets must remain real.
3. Start twenty `connectOrStartMusicSessionEffect` calls concurrently before the endpoint exists. Use alternating `hostKind: "opencode"` and `hostKind: "pi"` plus unique client IDs.
4. Retain each returned client immediately; if one call fails, dispose every client already returned and close the server in `finally`.
5. Assert:
   - exactly one launcher invocation;
   - one successful listener and one coordinator/provider ownership;
   - one provider event subscription and one initial polling/sample owner, not twenty;
   - all twenty calls complete negotiated hello with the same nonempty daemon instance ID and selected revision;
   - the owned marker is absent after convergence;
   - no second socket/provider generation appears.
6. Dispose one client, then complete a real operation or observe live traffic through another client and confirm the other nineteen remain usable.
7. Dispose the remaining clients and close the server. Assert one event-source disposal, one provider disposal, socket removal, marker removal, and no bind-reservation debris.
8. This is in-process launcher injection only; do not duplicate Phase 2's child-process race.

### 6. Prove incompatibility at all startup race positions

Use a healthy real selected server and existing disjoint range `{ major: 1, minRevision: 9, maxRevision: 10 }`. In every case retain a supported client to prove the daemon generation stays healthy.

#### Before marker acquisition

1. Start the server first, capture the socket identity, then call `connectOrStart` with the disjoint range.
2. Assert exact `INCOMPATIBLE_PROTOCOL` details include client and daemon ranges.
3. Assert one probe, zero marker acquisition/unlink, zero launcher call, zero cleanup, and no scheduled continuation.

#### After marker acquisition

1. Begin with a missing endpoint. Let this caller acquire its real marker.
2. Use its one authorized launcher invocation to start a normal current server; the caller's next completed hello is incompatible because its offered range is disjoint.
3. Assert terminal incompatibility, exactly one launch, owned-marker release, no second launch/replacement/cleanup, and unchanged healthy socket identity.

#### While waiting on another launcher

1. Install a valid live marker owned by the test/another attempt so discovery returns `starting` and grants no cleanup.
2. Fork the disjoint-range workflow under `TestClock`; prove it waits without acquiring or spawning.
3. Start a healthy current server while the caller is sleeping, advance only the next virtual delay, and require the next hello to fail incompatibly.
4. Advance virtual time beyond the full schedule and prove probe/launcher counts no longer change.
5. Assert the foreign marker remains untouched, the socket identity remains unchanged, and a supported client completes a live request.

Across all three cases:

- never signal, kill, unlink, replace, or retry against the healthy incompatible generation;
- dispose any client created during a probe that later fails cleanup;
- assert an existing supported client remains live through a real post-race request, not merely cached state;
- clean server/client/marker/temp resources in `finally` without weakening ownership assertions.

### 7. Preserve single-generation semantics

1. After one successful `connectOrStart`, close its live server/socket.
2. Assert the returned client settles according to the verified explicit-client terminal behavior and does not invoke its launcher or start another generation.
3. Do not add a reconnect fiber, retained-state supervisor, replacement-generation filtering, or command replay. Those are Phase 4.

### 8. Keep the phase isolated and green

1. Update `config.ts` only if startup timing validation or narrow marker finalization support requires it. Preserve runtime path, owner/mode/type, token/inode, and stale cleanup policy.
2. Do not alter Phase 1 selected ownership or Phase 2 process-contender behavior.
3. Format only touched files and inspect the exact diff.
4. Keep work in the current reviewed Jujutsu phase child. Do not run `git commit`, `jj commit`, `jj squash`, push, or open a PR. After approval, the orchestrator may squash only this reviewed phase through the prescribed workflow.

## Acceptance checks

Phase 3 is complete only when:

- The real Effect startup workflow is proven with `TestClock`: immediate first attempt, no early retry, positive/capped pacing, success before exhaustion, exact attempt cap, typed timeout, and interruption with no later attempts.
- Twenty concurrent real managed callers converge on one lease winner, launch, listener, coordinator, provider/event/poll owner, and daemon instance; disposing one does not affect the others.
- Exact-owner marker release runs once on success, timeout, interruption, complete-workflow spawn failure, and terminal post-acquisition errors; replacements remain untouched.
- A release-only failure prevents false success; a primary failure remains primary while the release failure is retained through a deterministic observer/diagnostic.
- Incompatibility before acquisition, after acquisition, and while waiting is terminal with correct range details and no unauthorized acquisition, cleanup, spawn repetition, signal, kill, unlink, replacement, or retry continuation.
- Healthy supported clients remain live through real post-race requests and the healthy socket identity is unchanged.
- A returned startup client does not reconnect after live loss.
- Phase 1 and Phase 2 suites remain green as baseline only; no reconnect, idle, fan-out, artwork, host, package, or docs work enters this phase.
- Unrelated dirty content, verified commits, `.apnea/state.json`, and `docs/music-session-architecture.html` remain untouched.

## Verify commands

Run from the repository root:

```sh
bun test packages/music-core/tests/session-client.test.ts -t 'TestClock|20 concurrent|marker.*release|incompatib'
bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
# Baseline regression only; it does not enlarge Phase 3 acceptance.
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/client.ts
jj diff --summary
```

Inspect the exact phase diff:

```sh
jj diff --git packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
git diff --check
```

Confirm manually:

- only internal `StartupPending` continues the single bounded schedule;
- TestClock tests exercise the production schedule rather than a duplicate loop;
- marker registration/finalization is interruption-safe and exact-owner only;
- release-only and primary-plus-release failures have truthful outcomes;
- the 20-client test fakes only process launch and uses real filesystem/listener/hello topology;
- all three incompatibility positions preserve the healthy generation and stop retrying;
- no reconnect, process-contender expansion, idle, fan-out, artwork, host, packaging, or docs changes entered the phase;
- `.apnea/state.json` and unrelated dirty paths were not altered.

## Dependencies

- Approved full plan at `.apnea/artifacts/plan.md`.
- Approved Phase 1 change `08acaab5` and Phase 2 change `73a988d6`.
- Existing `resolveMusicSessionStartup`, `connectOrStartMusicSessionEffect`, `discoverMusicSession`, `acquireStartupMarkerLease`, launcher seam, `MusicSessionStartupError`, and opaque lease authority.
- Existing real selected `startMusicSessionServer`, `createFakeProvider`, runtime resolver, real client hello, and disjoint protocol-range behavior.
- Repository-pinned Effect v4 `Schedule`, `TestClock`, deterministic random/test services, fibers, `Exit`, `Ref`, scopes, and finalizers.

## Non-goals

- Reconnect supervision, replacement-generation adoption, retained state across loss, or command replay.
- Idle grace/daemon exit, 24-client load/backpressure, artwork/cache, OpenCode, Pi, manifests, packed smokes, READMEs, or architecture HTML.
- Reopening selected graph shutdown/readiness or separate-process singleton acceptance except to fix a direct regression exposed by this phase.
- Protocol/schema/capability changes, process killing/replacement, launchd/service installation, remote sockets, multi-user sharing, or durable history.
- New source/test modules, unrelated cleanup, commits or squashing during coding, pushing, publishing, opening a PR, or editing `.apnea/state.json`.
