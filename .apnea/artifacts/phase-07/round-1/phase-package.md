---
status: done
---

# Phase 7 package: centralize and bound native artwork reads

## Intent

Add a negotiated, bounded session request for native `media-control get --now` artwork. Within the session architecture, only the daemon/provider may execute that native read; clients submit the full current recording identity and receive a stable bounded result.

The daemon must verify identity against authoritative state before the native read, verify the native sample itself, and re-check authoritative state after the read. Concurrent identical requests share one scoped Effect cache lookup. Cache/in-flight entries are capacity-bounded, transient failures are not retained as successful results, and artwork work cannot block state fan-out or the global transport lane.

Keep all catalog lookup, download, conversion, accent/cell generation, Kitty rendering, and presentation in OpenCode. This phase exposes the core capability; OpenCode production cutover remains Phase 9.

Use repository-pinned Effect v4 `Schema`, scoped cache/synchronization, Layers, and supervised effects. Preserve Phase 6 frame/outbound bounds; never log or fan out artwork bytes.

## Files to touch

Only as required:

- `packages/music-core/system-media.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/config.ts` if cache/payload limits need config ownership
- `packages/music-core/index.ts`
- `packages/music-core/tests/system-media.test.ts`
- `packages/music-core/tests/session-protocol.test.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`
- `packages/music-core/tests/session-coordinator.test.ts` only for cache/authority behavior that belongs to the coordinator

Do not create a new source or test module.

## Files not to touch

- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/session/framing.ts`
- `packages/music-core/run.ts` unless an actual bounded-command defect prevents the native read (prefer the existing bounded runner)
- `packages/music-core/types.ts` unless a host-neutral exported artwork identity/result type cannot live in `protocol.ts`
- `packages/music-core/package.json`
- `packages/music-core/project.json`
- Anything under `packages/opencode-music-player/`
- Anything under `packages/pi-music-dock/`
- `README.md`, package READMEs, and `docs/music-session-architecture.html`
- `.apnea/state.json` and unrelated `.apnea` tasks/artifacts

Do not move OpenCode artwork resolver/cache/rendering code into core.

## Exact implementation steps

### 1. Preserve the bounded session baseline

1. Retain approved Phase 1–6 ownership, startup, reconnect, idle, 24-client fan-out, per-client writer, state coalescing, and overflow behavior.
2. Keep state/status replay independent from request handling. A blocked artwork lookup must not block coordinator state publication or another client's transport.
3. Keep existing low-level `createSystemMedia()` behavior and exports compatible. Normal sampling/stream commands continue using `--no-artwork`.

### 2. Define one full recording identity and stable wire outcomes

In `packages/music-core/session/protocol.ts`:

1. Add an Effect `Schema` for a full host-neutral artwork identity using all current track fields required to reject stale reads: provider/content ID, title/name, artist(s), album, and duration in milliseconds.
2. Use one canonical field spelling across request, client, coordinator, and public exports. Bound every identity string and require finite non-negative safe duration so a request itself is bounded before provider work.
3. Add an artwork request with normal strictly increasing `requestId` and the identity.
4. Add a schema-owned artwork result union with explicit bounded outcomes equivalent to:
   - `available` with validated base64 bytes;
   - `unavailable` when no native artwork/provider support exists;
   - `stale` when identity changes or does not match;
   - `too-large` when native data exceeds the configured/session frame bound.
5. Keep malformed requests as `INVALID_REQUEST`, missing negotiation as `UNSUPPORTED_CAPABILITY`, and genuine provider execution failures as `PROVIDER_FAILURE`. Do not overload command results or return raw defects.
6. Add a `native-artwork` capability and advance the additive wire revision if required. Current and immediately previous revisions must still negotiate successfully; older peers simply omit the capability and continue state/transport operation.
7. Update request/server-frame decoders, request-ID extraction, response helpers/types, and schema tests. Do not add artwork events or include artwork in replayed player state.

### 3. Add config-owned payload and cache bounds

If not already derivable safely from Phase 6 settings, in `packages/music-core/session/config.ts`:

1. Add positive safe-integer limits for decoded native artwork bytes and artwork cache capacity.
2. Add defaults, resolved fields, and matching environment-backed `Config` entries.
3. Ensure an `available` base64 response plus envelope fits `maxFrameBytes`. Either validate the configured relationship or derive the effective native-byte bound conservatively from `maxFrameBytes`.
4. Reject invalid/reversed/impossible settings through `MusicSessionConfigError` before listener/provider acquisition.
5. Keep limits finite even when callers override `maxFrameBytes`.

Do not raise/remove Phase 6 bounds merely to accept arbitrary images. Oversized native art must produce `too-large` and allow OpenCode's later catalog fallback.

### 4. Add a bounded native read to the system-media adapter

In `packages/music-core/system-media.ts`:

1. Extend only `SystemMediaAttemptAdapter` (or another daemon-facing adapter seam), not the general host `MusicBackend`, with a native artwork read accepting expected identity and byte bound.
2. For `media-control`, run exactly `media-control get --now`; normal samples/streams remain `--no-artwork`.
3. Use the existing bounded/timeout command runner. Before JSON/base64 decoding, reject output whose encoded size cannot fit the configured native limit/envelope.
4. Decode the returned object defensively. Derive its complete identity from `contentItemIdentifier`, title, artist, album, and rounded duration using the same normalization as playback samples.
5. Return `stale` unless every identity component exactly matches the requested identity. Missing or changed IDs must not be rescued by matching title alone.
6. Validate `artworkData` as canonical nonempty base64, compute decoded size without allocating beyond the limit, and return `too-large` before retaining oversized bytes.
7. Return `unavailable` for missing/empty/malformed unsupported artwork data and non-`media-control` providers. Return a typed provider failure for command timeout/failed execution rather than caching it as no artwork.
8. Never decode images, fetch catalog art, convert PNG/JPEG, calculate colors/cells, or write files here.

Add system-media tests for exact command, exact identity match, each identity mismatch, malformed JSON/base64, empty art, unavailable backend, timeout/failure, boundary-size success, and one-byte-over-limit rejection.

### 5. Thread the provider boundary without duplicating native ownership

In `packages/music-core/session/provider.ts`:

1. Add a typed `nativeArtwork(identity, maxBytes)` Effect to `SessionProvider` that delegates to the one selected adapter.
2. Map adapter execution failures to tagged `ProviderError` operation `artwork`; preserve stable unavailable/stale/too-large values as normal results.
3. Extend legacy/fake provider seams additively. Existing providers that omit native artwork return `unavailable`; they must not fail provider acquisition.
4. Add deterministic fake controls/counters for artwork calls, blocking/release, failure, and result only as needed by coordinator/server tests.
5. Keep provider Layer acquisition/event/poll ownership exactly once and let provider scope interruption cancel in-flight artwork effects.

### 6. Put authority checks and cache ownership in the coordinator

In `packages/music-core/session/coordinator.ts`:

1. Add `artwork(identity)` to `MusicSessionCoordinator` separately from the global transport queue.
2. Read current authoritative state before cache/provider work. If no track or any identity field differs, return `stale` with zero provider call.
3. Key cache/in-flight deduplication by the complete canonical identity, not only provider ID or title.
4. Use an Effect-scoped cache/request deduplication primitive owned by the coordinator scope. Do not add a module-global `Map` or detached Promise job.
5. Configure finite capacity. Concurrent equal keys share exactly one provider effect; different keys remain bounded by cache/in-flight capacity.
6. Cache only successful `available` results as settled values unless a clearly stable unavailable result is intentionally short-lived. Provider failures, interruption, stale, malformed, and too-large outcomes must not become durable successful entries. Explicitly invalidate/remove failed/transient entries before returning.
7. After the native read, re-read authoritative state. If identity changed during the read, discard bytes and return `stale`; never populate the cache for that stale completion.
8. If identity remains current, return the bounded provider result. Cache insertion and eviction must be atomic enough that capacity is never exceeded.
9. Coordinator shutdown interrupts in-flight artwork lookups and finalizes the cache before provider scope closure under the Phase 1 order.
10. Artwork lookup must not enter `commands`, reserve a poll deadline, mutate playback state, or serialize unrelated state/transport work.

Add coordinator tests proving pre-read stale rejection, post-read stale rejection, equal-key deduplication, capacity eviction, transient failure retry, cancellation/finalization, and command/state progress while artwork is blocked.

### 7. Serve artwork only after capability negotiation

In `packages/music-core/session/server.ts`:

1. Handle artwork only after hello and strict request-ID validation.
2. Require negotiated `native-artwork`; otherwise return one correlated `UNSUPPORTED_CAPABILITY` response and keep the connection healthy.
3. Call `coordinator.artwork(identity)` and map its stable result or tagged failure into one correlated response.
4. Send the response through Phase 6's bounded mandatory outbound lane. Never place artwork in the coalescing state slot.
5. If the final encoded response exceeds `maxFrameBytes` despite upstream checks, return/contain a stable too-large outcome rather than crashing the runtime or silently dropping the response.
6. A blocked/failed artwork request affects only that connection request. State/status forwarders and other clients remain live.
7. Do not log identity metadata or base64. Diagnostics may include operation, result kind, byte count, and tagged error only.

### 8. Add explicit and reconnecting client methods

In `packages/music-core/session/client.ts`:

1. Extend pending request bookkeeping with a discriminated artwork pending type; do not decode an artwork success as a transport result.
2. Add `artwork(identity)` to explicit and reconnecting client contracts.
3. Validate identity through the protocol schema before allocating request ID/pending state or writing.
4. If `native-artwork` was not negotiated, reject immediately with `UNSUPPORTED_CAPABILITY` and write nothing.
5. Correlate exactly one bounded artwork result to its request. Duplicate/unsolicited responses cannot settle another request.
6. On socket loss, artwork rejects `CONNECTION_LOST`; transport commands retain `INDETERMINATE_COMMAND`. On disposal, artwork rejects `DISPOSED`.
7. The reconnecting wrapper delegates artwork once to the active generation. It does not queue or replay the request after loss; callers may explicitly request again after replacement replay.
8. Generation fencing must ignore a late artwork completion from generation A after B is adopted or the wrapper is disposed.

### 9. Export only the host-neutral client surface

In `packages/music-core/index.ts`:

1. Export artwork identity/result types and the updated explicit/reconnecting client types needed by later host adapters.
2. Export no provider/coordinator/cache internals, native runner dependency, cache key implementation, or test controls.
3. Keep `createSystemMedia()` as the existing low-level compatibility export; do not add host presentation types to core.

### 10. Prove end-to-end identity, bounds, and non-interference

In `session-protocol.test.ts`, `session-client.test.ts`, and `session-server.test.ts`:

1. Negotiate `native-artwork` with a real selected server/client and request the exact current identity; require an `available` bounded result.
2. Request mismatched identity and assert `stale` with zero native provider call.
3. Block a native read, change authoritative state to a different recording, release it, and assert stale completion with no bytes/cache entry.
4. Start multiple concurrent equal requests from different clients and assert one provider native call and equal correlated results.
5. Request the same available identity again and prove a cache hit; then exceed cache capacity with distinct identities and prove deterministic eviction/re-read.
6. Fail one provider read and assert correlated `PROVIDER_FAILURE`; repeat and prove a fresh provider call succeeds (failure was not cached).
7. Exercise unavailable, malformed native data, exact payload boundary, too-large payload, disconnect while pending, disposal while pending, and late old-generation completion.
8. Use a peer without `native-artwork`; require correlated unsupported error while its state stream and later command remain healthy.
9. While artwork is blocked, emit a later state and run a command from another client; both must complete without waiting for artwork.
10. Dispose/close every client, provider gate, server scope, and temporary runtime in `finally`. Bound waits with Effect sentinels that enter cleanup.

### 11. Preserve host-local presentation boundaries

1. Do not edit `packages/opencode-music-player/system-media.ts`, `artwork.ts`, `artwork.tsx`, `kitty-graphics.ts`, or UI files.
2. Do not move OpenCode's iTunes lookup, HTTP download, retries, presentation cache/jobs, image conversion, accent/cell generation, Kitty/half-block rendering, or completion events into core.
3. The later OpenCode adapter will replace only its native callback with `client.artwork(identity)` and retain catalog fallback locally.
4. Pi receives no artwork behavior in this phase.

### 12. Keep Phase 7 isolated

1. Do not migrate OpenCode or Pi production selection.
2. Do not alter 24-client capacities, idle policy, reconnect policy, or command FIFO except for direct regressions exposed by artwork tests.
3. Format only touched files and inspect the exact diff.
4. Keep work in the current reviewed Jujutsu phase child. Do not run `git commit`, `jj commit`, `jj squash`, push, or open a PR. After approval, the orchestrator may squash only this reviewed phase through the prescribed workflow.

## Acceptance checks

Phase 7 is complete only when:

- A schema-owned, revision/capability-negotiated native artwork request/result is bounded and additive for older peers.
- The complete current recording identity is checked against authoritative state before and after the native read and against the native `get --now` sample itself.
- The daemon/provider is the sole session-side owner of `media-control get --now`; ordinary samples/streams remain `--no-artwork`.
- Concurrent identical requests share one scoped Effect lookup; settled/in-flight entries are capacity-bounded, eviction works, and transient failures/stale results are not retained incorrectly.
- Unsupported, stale, unavailable, malformed, too-large, provider-failed, disconnected, and disposed requests have stable correlated outcomes without disrupting state fan-out or commands.
- Artwork responses use the bounded mandatory lane, never state coalescing, and never exceed frame/payload limits or appear in logs.
- Explicit and reconnecting clients never replay artwork requests and ignore late old-generation completions.
- No catalog/network/image/presentation code moves into core and no host production code changes.
- Phase 1–6 suites remain green as baseline only.
- Unrelated dirty content, verified commits, `.apnea/state.json`, and `docs/music-session-architecture.html` remain untouched.

## Verify commands

Run from the repository root:

```sh
bun test packages/music-core/tests/system-media.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts -t 'artwork|capability|payload'
bun test packages/music-core/tests/system-media.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-coordinator.test.ts
# Baseline regression only; it does not enlarge Phase 7 acceptance.
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

Inspect boundaries and exact diff:

```sh
jj diff --git packages/music-core/system-media.ts packages/music-core/session/provider.ts packages/music-core/session/coordinator.ts packages/music-core/session/protocol.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/config.ts packages/music-core/index.ts packages/music-core/tests/system-media.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-coordinator.test.ts
git diff --check
! rg -n 'itunes|itunes\.apple|pngjs|kitty|half.block|artworkUrl|fetch\(' packages/music-core
```

Confirm manually:

- native reads occur only behind the selected provider and run `media-control get --now`;
- request identity uses every required recording field and is checked three times (state before, native sample, state after);
- cache ownership is scoped/capacity-bounded and does not retain failures/stale bytes;
- payload/base64/frame bounds are checked before large allocation/write;
- artwork never enters replay state, state coalescing, command FIFO, or diagnostics;
- old peers remain healthy without capability;
- no OpenCode/Pi, packaging, or docs changes entered the phase;
- `.apnea/state.json` and unrelated dirty paths were not altered.

## Dependencies

- Approved full plan at `.apnea/artifacts/plan.md`.
- Approved Phase 1 (`08acaab5`), Phase 2 (`73a988d6`), Phase 3 (`788473b7`), Phase 4 (`b376a94d`), Phase 5 (`82853612`), and Phase 6 (`caf926c9`) changes.
- Existing selected provider/coordinator graph, `SubscriptionRef` authority, schema-owned protocol, bounded mandatory writer, explicit/reconnecting clients, and fake provider/server fixtures.
- Existing OpenCode artwork identity semantics as a boundary reference only; no OpenCode file changes.
- Repository-pinned Effect v4 Schema, scoped cache/request deduplication, Layers, scopes, fibers, `Ref`, and synchronization APIs.

## Non-goals

- OpenCode adapter/cutover, Pi artwork, host UI/loading/toasts, iTunes/catalog lookup, HTTP download, image conversion, color/cell computation, Kitty/half-block rendering, or presentation events.
- General binary transfer, artwork push events, embedding artwork in `PlayerState`, remote/TCP access, durable artwork storage, or cross-user cache.
- Reworking singleton/startup/reconnect/idle/fan-out policy, process replacement, launchd/service installation, or multi-user support.
- New source/test modules, unrelated cleanup, commits or squashing during coding, pushing, publishing, opening a PR, or editing `.apnea/state.json`.
