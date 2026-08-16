---
status: done
---

# Phase 5 package: race-safe singleton auto-start and skew policy

## Intent

Add `connectOrStart` on top of Phase 4's secure discovery. Concurrent first use must converge on one machine-local daemon, one Unix listener, and one provider/coordinator owner. An exclusively created same-user startup marker coordinates launchers, but successful socket bind remains the final singleton authority.

The launcher must start the packaged executable detached with no inherited stdio/IPC/host handle, then wait for a completed negotiated hello with a bounded jittered Effect `Schedule`. A healthy incompatible daemon generation is terminal: no stale cleanup, marker takeover, spawn, signal, unlink, replacement, or retry loop.

Preserve the approved explicit client, endpoint security, protocol, provider/coordinator behavior, and scoped server/process cleanup. Keep unrelated worktree content and `docs/music-session-architecture.html` untouched. Use repository-pinned Effect v4 only.

## Files to touch

Only as required:

- `packages/music-core/session/config.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

## Files not to touch

- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/framing.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/system-media.ts`
- `packages/music-core/index.ts`
- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/scripts/verify-pack.ts`
- `packages/music-core/tests/session-protocol.test.ts`
- `packages/music-core/tests/system-media.test.ts`
- `packages/music-core/tests/session-coordinator.test.ts`
- Anything under `packages/opencode-music-player/`
- Anything under `packages/pi-music-dock/`
- `README.md`, package READMEs, and `docs/music-session-architecture.html`
- `.apnea/state.json` and unrelated `.apnea` tasks/artifacts

Do not create another source/test module. Keep marker/config policy in `config.ts`, launcher/client workflow in `client.ts`, listener-first ownership in `server.ts`/`music-sessiond.ts`, and evidence in the existing focused tests.

## Required singleton policy

Implement these decisions exactly:

1. `connectOrStart` always probes first. A healthy compatible endpoint returns immediately; a healthy incompatible endpoint fails immediately with the existing structured incompatibility error.
2. Only Phase 4 `missing` or guarded `stale` outcomes may proceed toward marker acquisition. Unsafe or conservative `occupied` outcomes never spawn or remove anything.
3. `starting` means another valid marker owner may be launching. Wait with the bounded startup schedule; do not take over while that marker remains conservatively live/unknown.
4. Marker creation uses exclusive filesystem creation (`wx`/equivalent) inside the verified `0700` runtime directory. Exactly one concurrent launcher wins.
5. The marker is coordination only. A listener that successfully binds the managed socket is singleton authority even if marker state is missing, stale, bypassed, or raced.
6. After winning the marker, probe again before spawning. A daemon may have appeared between the first probe and marker acquisition.
7. A marker winner may perform only cleanup authorized by Phase 4's stale proof, then spawn at most once for that `connectOrStart` call.
8. All launchers wait for a completed hello, not path appearance or connect alone. Supported peers share the live generation.
9. Incompatibility observed before marker acquisition, after acquisition, or while waiting is terminal and is never retried against that healthy generation.
10. A spawned child that loses bind exits before acquiring provider/event/coordinator ownership. It never unlinks or disturbs the winner.
11. Commands are outside startup. `connectOrStart` returns a new handshaken client and never replays a command. Live-loss reconnect remains Phase 6.
12. Marker release is exact-owner and idempotent. It happens after success, spawn failure, bounded timeout, interruption, or terminal error, but never unlinks another attempt's replacement marker.

## Exact implementation steps

### 1. Add validated startup timing and typed startup failures

In `packages/music-core/session/config.ts`:

1. Add validated startup timing defaults sufficient to build a bounded retry schedule, for example:
   - positive initial delay;
   - positive capped maximum delay;
   - positive maximum attempts or total bound.
2. Thread concrete overrides through existing config resolution for deterministic tests. If environment-backed client startup settings are exposed, read them through Effect `Config`; do not read `process.env` in workflow logic.
3. Reject zero, negative, non-finite, non-integer, reversed, or otherwise unbounded settings through the existing tagged config boundary.
4. Add a schema-tagged startup/launch error in the owning module (`config.ts` for marker/filesystem failures or `client.ts` for workflow/spawn/timeout failures) with stable operation and message plus preserved cause. Do not reuse `INCOMPATIBLE_PROTOCOL` for startup failures.
5. Preserve all Phase 4 runtime-path, owner/mode/type, path-length, and explicit-path semantics unchanged.

### 2. Implement an exclusive startup-marker lease

In `packages/music-core/session/config.ts`:

1. Extend the Phase 4 marker support with a scoped lease API. Production acquisition must:
   - revalidate the managed directory;
   - call `open(markerPath, "wx", 0o600)` or equivalent exclusive creation;
   - never follow or overwrite an existing path;
   - write schema-valid version/UID/PID/attempt-token JSON bounded by the existing marker size;
   - flush and close the file handle;
   - `lstat` the resulting regular file and capture device/inode/owner/mode plus attempt token.
2. Use a fresh cryptographically strong attempt token for each acquisition. Keep token generation injectable for deterministic tests; production uses `randomUUID`/equivalent.
3. Represent outcomes explicitly:
   - acquired lease;
   - already exists/another launcher;
   - typed unsafe/runtime failure.
   Do not treat every open failure as contention.
4. The lease exposes only safe operations needed by `connectOrStart`: identify its managed paths, prove it still owns the exact marker, permit endpoint discovery while ignoring only that exact owned marker, and release itself.
5. Release must revalidate directory plus marker device/inode/type/UID/mode/content token before unlink. `ENOENT` is success; replacement or mutation fails safely and remains untouched.
6. Make release idempotent and compatible with Effect finalization. If normal work and release both fail, preserve the primary error and retain/report the release error.
7. Keep raw marker writes, proofs, and path-based unlink private. Do not expose a generic marker deletion API.
8. Retain Phase 4 conservative behavior for live/unknown foreign markers and stale cleanup. Phase 5 may remove a proven dead marker after a healthy compatible hello, but must never remove the healthy socket; do not do this on incompatibility.

### 3. Create the detached packaged-daemon launcher

In `packages/music-core/session/client.ts`:

1. Add a narrow launcher dependency interface for tests, with production implemented using `node:child_process` and the packaged `dist/music-sessiond.js` relative to the installed core package.
2. Resolve the executable and daemon entry as absolute paths. Use argument arrays and `shell: false`; never construct a shell command.
3. Spawn production with:
   - detached process group on POSIX;
   - `stdio: "ignore"` (no inherited stdin/stdout/stderr or IPC);
   - no extra host file descriptors;
   - no shell;
   - no explicit custom socket flag for the production managed default;
   - an exact environment that cannot redirect the daemon away from the resolved managed default.
4. Observe synchronous spawn failure and the child's initial `error` event. Await the successful `spawn` event, remove temporary listeners, call `unref()` exactly once, and retain no child/process/stdio handle in the returned client workflow.
5. Do not await child exit as startup success. A completed protocol hello is success; a fast child exit is only diagnostic while the bounded probe schedule remains authoritative.
6. Do not send signals or kill a child on timeout/incompatibility. It may have won bind and be about to become healthy; socket authority and later probing decide.
7. Keep launcher path/spawn dependencies injectable without adding CLI flags or test environment switches to the shipped daemon.

### 4. Refactor listener acquisition ahead of provider ownership

The current server Layer asks for the coordinator before it binds. A manually started or marker-racing loser can therefore acquire provider work before discovering bind loss. Fix that ordering in `packages/music-core/session/server.ts`:

1. Split bound-listener ownership into a scoped Context service/Layer in this same file. It must depend only on resolved config and acquire:
   - secure managed directory preparation when applicable;
   - `net.Server` creation;
   - bind/listen;
   - `0600` hardening;
   - exact bound-path identity;
   - listener error observation and final close/unlink.
2. Until the coordinator-backed connection handler is installed, attach an exact temporary connection callback that immediately destroys early sockets. Remove it when activating the real handler and in listener finalization.
3. Keep the existing server service Layer responsible for coordinator-backed connection scopes, replay forwarding, command handling, and connection cleanup, but make it consume the already-bound listener service.
4. Ensure dependency finalization order remains:
   - stop/refuse new application connections;
   - interrupt/await connection children;
   - release coordinator/provider;
   - close listener and unlink its exact bound identity.
   Equivalent ordering is acceptable if listener closure occurs before provider release only where needed to stop acceptance, but no provider work may survive scope completion.
5. Preserve Phase 1 close/unlink diagnostics, closing refusal, failure propagation, and exact identity protection. Do not duplicate listener/path ownership across two finalizers.
6. Expose one in-file graph constructor or named Layers so both `startMusicSessionServer` and the executable compose the same listener-first topology. Test provider replacement must not bypass listener-first ordering.
7. Gate provider Layer acquisition on successful listener service acquisition. Do not edit provider/coordinator production modules merely to force ordering.
8. If bind/hardening fails, no provider adapter, event source, coordinator worker, polling fiber, or signal foreground should be acquired.
9. If two daemon graphs race bind despite marker coordination, exactly one reaches provider acquisition; the loser exits tagged/nonzero and never unlinks the winner.

### 5. Preserve the executable boundary while using listener-first composition

In `packages/music-core/session/music-sessiond.ts`:

1. Replace only the graph composition with the shared listener-first topology from `server.ts`. Keep the Phase 1 injectable runner, one top-level `Effect.runPromise`, scoped signal wait, diagnostics, and cleanup outcome handling.
2. No-argument execution still selects the Phase 4 managed default. Explicit `--socket` remains foreground/unmanaged behavior.
3. A bind loser must report a tagged listen/hardening failure, set nonzero status, and finish without provider acquisition.
4. Do not make the daemon create or own the startup marker. The launcher owns marker lifetime; socket bind remains daemon authority.
5. Do not daemonize again inside the executable. Detachment belongs only to the launcher spawn options.

### 6. Implement the Effect-native `connectOrStart` workflow

In `packages/music-core/session/client.ts`:

1. Add an Effect workflow plus a thin Promise adapter named consistently with `connectOrStartMusicSession`/`connectOrStart`. Keep it in this module; defer `index.ts` export cleanup.
2. Reuse `discoverMusicSessionEndpoint` for each attempt. Do not duplicate filesystem safety or hello classification.
3. Keep startup state in Effect `Ref`/scoped state:
   - optional owned marker lease;
   - whether this call has spawned;
   - the one primary failure if any.
4. One attempt applies this state machine:
   - `healthy` → return its client;
   - `incompatible` → fail immediately with that exact `MusicSessionClientError` and details;
   - unsafe runtime error → fail immediately;
   - unowned `occupied` without a valid active startup marker → fail conservatively without spawn;
   - `stale` → invoke only its guarded cleanup, then request another attempt;
   - `starting` → request another attempt without acquiring/removing/spawning;
   - `missing` → try exclusive marker acquisition.
5. After acquiring the marker, immediately rediscover while ignoring only that exact marker:
   - healthy/incompatible handling remains as above;
   - stale cleanup may run only through the returned guard;
   - missing permits one spawn;
   - occupied/unsafe remains conservative.
6. Spawn at most once after the owned marker and second probe both authorize it. A spawn failure fails this call and releases its marker; do not retry spawn inside the same call.
7. Pace pending attempts with one bounded exponential/capped, jittered Effect `Schedule`. Retry only an internal typed `StartupPending`; do not retry incompatibility, unsafe artifacts, occupied peers, spawn failure, or config defects.
8. On schedule exhaustion, fail with a typed startup-timeout error. Include operation/context but no playback data.
9. Install marker release as a scoped finalizer as soon as acquisition succeeds. It must run on successful hello, terminal failure, timeout, defect, and interruption.
10. On a healthy compatible endpoint with a separately proven dead marker, clean only that marker after hello. Leave live/unknown markers and all incompatible endpoints untouched.
11. Return ownership of the newly created explicit client to the caller. The workflow itself owns no long-lived reconnect fiber after return.
12. The Promise adapter may call `Effect.runPromise` once at the public boundary. It must not create a detached Promise polling loop or raw timer.

### 7. Add deterministic marker and scheduling tests

In `packages/music-core/tests/session-client.test.ts`:

1. Use real secure temporary runtime directories and real exclusive marker creation.
2. Race many marker acquisitions; prove exactly one lease wins, all losers classify contention, and release removes only the winner's exact marker once.
3. Replace/mutate the marker before release and prove the lease refuses to unlink it.
4. Interrupt or fail an Effect holding a lease and prove scoped release occurs without removing neighboring artifacts.
5. Exercise the real startup schedule with `TestClock` and deterministic random/jitter service or an injected deterministic schedule:
   - pending attempts are paced rather than busy-looped;
   - attempts are capped;
   - success before exhaustion returns;
   - exhaustion produces the typed timeout;
   - incompatibility and occupied/unsafe outcomes perform one attempt with no schedule continuation.
6. Do not use `setTimeout`, `Bun.sleep`, wall-clock timestamps, or polling loops.

### 8. Prove concurrent first use with real sockets and one fake provider

In `packages/music-core/tests/session-client.test.ts` and `packages/music-core/tests/session-server.test.ts`:

1. Inject a launcher that starts the real listener-first server graph on a real managed Unix path with the existing instrumented fake provider. The hook replaces only process creation; it must not fake discovery, marker acquisition, bind, hello, or client sockets.
2. Start at least 20 concurrent `connectOrStart` calls for alternating test identities before an endpoint exists.
3. Assert:
   - one exclusive marker winner;
   - one launcher invocation;
   - one successfully bound listener;
   - one provider object/event subscription/coordinator acquisition;
   - every caller receives a handshaken client with the same daemon instance ID;
   - marker is removed after convergence;
   - disposing one returned client does not affect the others.
4. Keep all returned clients/server scopes/marker gates failure-safe in `finally`.
5. Add a lower-level two-daemon bind race that bypasses or defeats marker coordination. Assert one listener/provider winner and zero provider/event/coordinator acquisition for the bind loser.
6. Prove the loser cannot unlink/chmod/close the winner's socket and the winner remains connectable.

### 9. Prove detached launch options and skew behavior

In `packages/music-core/tests/session-client.test.ts`:

1. With a narrow fake child-process object, assert production launcher arguments/options exactly: packaged daemon entry, detached, ignored stdio, no IPC/shell, successful-spawn observation, listener removal, and one `unref`.
2. Assert spawn throw/initial error is typed, releases the owned marker, and causes no second spawn in that call.
3. Against an already healthy daemon, call `connectOrStart` with a supported range and prove zero marker acquisition/spawn.
4. Against the same healthy daemon, call with a disjoint range and prove:
   - exact `INCOMPATIBLE_PROTOCOL` with both ranges;
   - one probe only;
   - zero stale cleanup calls;
   - zero marker open/unlink;
   - zero spawn/unref/signal/kill;
   - healthy socket identity unchanged;
   - an existing supported client remains live.
5. Repeat incompatibility appearing after marker acquisition or while waiting, if needed through deterministic gates. Release only the launcher's own marker; never touch the endpoint or start a replacement.
6. Prove a valid legacy/current supported peer can join the auto-started daemon and share the existing provider.
7. After killing/closing the returned live endpoint, prove this Phase 5 client becomes terminal according to Phase 3 and does not auto-start a replacement; Phase 6 owns reconnect.

### 10. Keep the phase narrow and tree green

1. Format only touched files.
2. Run focused client/server tests, then all `music-core` targets.
3. Inspect `jj diff --summary` and exact diff. Preserve `.apnea/state.json`, `docs/music-session-architecture.html`, and unrelated paths.
4. Confirm production timing uses Effect `Schedule`, not raw timers, and process creation occurs only in the launcher boundary.
5. Keep work in the current Jujutsu phase child for review. Do not run `git commit`, push, or `jj squash` during the coding round. After approval, use the prescribed `jj squash` step for only this reviewed phase.

## Acceptance checks

Phase 5 is done only when:

- Concurrent missing-endpoint callers coordinate through exclusive marker creation, spawn once, complete negotiated hello, share one daemon instance, and remove only the winning marker.
- Listener bind is acquired before provider/coordinator work. A bind loser acquires zero provider/event/poll/command ownership and cannot disturb the winner.
- The packaged daemon launcher uses an absolute entry, detached process group, ignored stdio, no shell/IPC/inherited host descriptors, removes startup listeners, calls `unref` once, and retains no child handle.
- Startup waiting is bounded, capped, jittered, and driven by Effect `Schedule`; only internal pending startup is retried.
- Stale cleanup remains proof-guarded and marker release remains exact-owner/idempotent across success, failure, timeout, and interruption.
- Supported legacy/current clients join the same daemon/provider after automatic startup.
- A healthy incompatible generation is terminal before, during, and after launch races: it triggers no endpoint unlink/kill/replacement/spawn/retry loop, preserves both range details, and leaves healthy peers live.
- Spawn failure is typed, releases only the caller's marker, and is not retried in the same call.
- Returned clients retain Phase 3 one-generation behavior; live loss does not reconnect or auto-start.
- All approved Phase 1–4 tests remain green as regressions without becoming new Phase 5 acceptance work.

## Verify commands

Run from the repository root:

```sh
bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
! rg -n "setTimeout\(|setInterval\(|Bun\.sleep" packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
jj diff --summary
```

Inspect the diff after verification:

- changes are confined to allowed Phase 5 paths;
- process creation exists only at the narrow packaged-daemon launcher boundary;
- provider/coordinator production modules and protocol schemas are untouched;
- no reconnect, idle shutdown, load bounds, artwork, host, manifest, packing, or documentation work entered the phase;
- `.apnea/state.json` and unrelated dirty paths remain untouched.

## Dependencies

- Approved secure-runtime commit `ca96d66d`, explicit-client commit `1411d281`, negotiated-protocol commit `f059efc8`, process-boundary commit `e70641bc`, scoped-server commit `66bc1f91`, coordinator commit `859fc01d`, and provider commit `e7103663`.
- Phase 4 `ManagedRuntimeProbe`, guarded stale cleanup, marker schema/path security, managed/default executable selection, exact bound-path identity, and structured runtime/client errors.
- Existing fake provider counters, real Unix-socket test helpers, executable graph seam, and failure-safe resource patterns.
- Repository-pinned Effect v4 `Effect`, `Layer`, `Ref`, `Schedule`, `Schema`, `TestClock`, and scoped-finalizer APIs.
- Node/Bun child-process and Unix-domain socket support on macOS.

## Non-goals

- Reconnect after live loss, replacement-generation filtering, retained state while reconnecting, command replay changes, or zero-client idle shutdown.
- Slow-reader/backpressure policy, per-client/global load bounds, 24-client fan-out proof, artwork, or caching.
- Protocol revision/capability/message changes, provider/coordinator semantics, host migration, UI behavior, public index/manifests, packing, smokes, READMEs, or architecture HTML.
- Process killing/replacement, launchd/service installation, remote sockets, multi-user sharing, or durable daemon history.
- New source/test modules, publishing, Git commits, squashing before approval, pushing, opening a PR, editing `.apnea/state.json`, or resetting/cleaning unrelated worktree content.
