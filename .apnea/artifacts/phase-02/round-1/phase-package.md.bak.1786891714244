---
status: done
---

# Phase 2 package: schema-owned wire contract and revision negotiation

## Intent

Turn the existing explicit-path foreground protocol into one additive contract owned by Effect `Schema`. Add real wire-revision range and capability negotiation while preserving manually started server/client operation.

This phase ends with a current client and the immediately preceding wire revision sharing one already-running daemon/provider, and an incompatible client receiving one actionable typed failure without affecting healthy peers. It does not add discovery, process launch, reconnect, idle shutdown, load hardening, artwork, or host integration.

Preserve the approved provider, coordinator, server-lifecycle, and Phase 1 process-boundary commits. Keep all unrelated worktree content and `docs/music-session-architecture.html` unchanged. Use only the repository-pinned Effect v4 APIs.

## Files to touch

Only as required:

- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/framing.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/tests/session-protocol.test.ts`
- `packages/music-core/tests/session-server.test.ts`
- `packages/music-core/tests/session-client.test.ts`

`packages/music-core/session/framing.ts` need not change if its existing NDJSON boundary already satisfies the contract; retain its focused tests either way.

## Files not to touch

- `packages/music-core/session/config.ts`
- `packages/music-core/session/provider.ts`
- `packages/music-core/session/coordinator.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/system-media.ts`
- `packages/music-core/index.ts`
- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/scripts/verify-pack.ts`
- `packages/music-core/tests/system-media.test.ts`
- `packages/music-core/tests/session-coordinator.test.ts`
- Anything under `packages/opencode-music-player/`
- Anything under `packages/pi-music-dock/`
- `README.md`, package READMEs, and `docs/music-session-architecture.html`
- `.apnea/state.json` and unrelated `.apnea` tasks/artifacts

Do not broaden this phase merely to update package exports; Phase 13 owns final public-package surface cleanup. Existing relative imports can exercise the contract now.

## Contract decisions for this phase

Implement one explicit compatibility model rather than inferring compatibility from package versions:

1. Protocol major identifies a fundamentally incompatible family.
2. A client advertises an inclusive minimum/maximum wire-revision range for that major.
3. The daemon advertises its inclusive supported range and selects the highest revision in the overlap.
4. Treat the existing `{ major: 1, minor: 0 }` hello/hello-result shape as the immediately preceding legacy wire revision. Introduce one current range-negotiating revision and support exactly the current plus that preceding revision in this phase.
5. Package version remains diagnostics only. Never reject, replace, or classify compatibility from `PACKAGE_VERSION`.
6. Capabilities are negotiated as the daemon/client intersection in deterministic daemon order. `state-replay` is required for a successful session; `transport` is optional but required before accepting a transport request.
7. Unknown additive capabilities are ignored rather than treated as protocol incompatibility. Missing a capability for an action produces `UNSUPPORTED_CAPABILITY`, not `INCOMPATIBLE_PROTOCOL`.
8. A disjoint major/range produces `INCOMPATIBLE_PROTOCOL` with structured details containing both the client's offered range and daemon's supported range. The message must also be actionable when rendered without inspecting details.

Keep post-hello revision-1 messages wire-compatible unless a schema correction is required. Do not invent two nominally different but behaviorally untested “current” clients as skew evidence; the integration test must send the actual preceding legacy hello shape.

## Exact implementation steps

### 1. Define the complete wire model with Effect Schema

In `packages/music-core/session/protocol.ts`:

1. Define schemas first and derive TypeScript types from those schemas instead of maintaining parallel hand-written object types.
2. Add schema-owned types for:
   - protocol range and selected/negotiated protocol;
   - legacy hello protocol and legacy hello result;
   - capabilities and host kind;
   - hello, state, and transport requests;
   - provider status, track, device, player state, and revisioned state;
   - status/state events;
   - success and failure responses;
   - hello result;
   - stable protocol errors, including structured incompatibility details.
3. Model wire variants with discriminated `Schema` structs/unions using the existing external `type`, `ok`, `kind`, and action discriminators. Do not replace the JSON wire names with Effect-internal `_tag` fields.
4. Put semantic constraints in schemas/checks:
   - request IDs, revisions, progress, duration, fetched time, and seek positions are non-negative safe integers;
   - range minimum is not greater than maximum;
   - selected revision lies within the daemon range represented by the result;
   - seek requires `positionMs`, while non-seek transport must not semantically accept it;
   - response success/failure variants cannot contain contradictory required payloads;
   - nested track/device/state/status/error fields have the declared types and finite-number constraints.
5. Preserve additive object evolution: tolerate unrelated extra object fields where safe, while still validating every known semantic field. Do not use excess-field tolerance to bypass the seek/non-seek rule.
6. Keep the stable error codes already present. Extend only the incompatible-protocol variant with typed range details; do not expose defects or Node/Effect internals on the wire.
7. Keep constructor helpers such as `response`, `failure`, and `protocolError`, but have them construct values conforming to the schemas. Provide one incompatibility constructor that always includes both ranges.
8. Replace the current `record`, `id`, and `player` shape-validation path with decoders/guards derived from the schemas. `requestIdFromUnknown` may remain as a safe-correlation helper, but it must decode a minimal schema rather than cast an arbitrary record.
9. Expose decoding functions appropriate to their callers:
   - Effect-based unknown decoding for the server's Effect request path;
   - result/synchronous wrappers only where the Node client callback or focused pure tests require them.
   All wrappers must share the same schemas and error mapping; do not duplicate validation logic.
10. Map schema parse failures to the existing stable `ProtocolError` envelope at this boundary. Preserve specific public classifications for unsupported action, invalid seek, duplicate request ID, unsupported capability, and incompatible protocol instead of leaking `ParseError` formatting.

### 2. Implement pure range and capability negotiation

In `packages/music-core/session/protocol.ts`:

1. Define one exported current protocol descriptor containing major and supported revision range. Retain a clear legacy mapping from existing major/minor `1.0` to the preceding revision.
2. Implement a pure negotiation helper:
   - majors must match;
   - overlap lower bound is the greater minimum;
   - overlap upper bound is the lesser maximum;
   - no overlap returns the structured incompatible error;
   - overlap selects its upper bound.
3. Normalize a decoded legacy hello to a one-revision offered range. Preserve enough decoded information for the server to emit the legacy hello-result shape to that peer.
4. Intersect capabilities deterministically using daemon capability order. Require `state-replay`; permit a state-only client without `transport` to complete hello.
5. Return one negotiated value containing selected revision, negotiated capabilities, and whether legacy response encoding is required. Avoid mutable module-global negotiation state.
6. Unit-test range endpoints, highest-overlap selection, disjoint ranges, major mismatch, reversed/malformed ranges, unknown capabilities, and required-capability absence.

### 3. Apply the schema boundary and negotiated contract in the server

In `packages/music-core/session/server.ts`:

1. Keep all Phase 1 listener, connection scope, closing gate, cleanup, and process behavior unchanged.
2. For each connection, replace the `hello` boolean with connection-local negotiated session state that is absent before hello and contains selected revision/capabilities afterward.
3. Decode every inbound frame through the shared request schema boundary. Do not inspect unknown objects with casts such as `as Partial<ProtocolError>`.
4. Preserve safe correlation:
   - malformed input without a schema-valid non-negative request ID closes only that connection;
   - malformed but safely correlatable input receives one stable failure response;
   - request IDs remain strictly increasing, including rejected requests.
5. Require hello first. Decode both:
   - the actual preceding legacy `{ major: 1, minor: 0 }` hello;
   - the current range-advertising hello.
6. Negotiate major/range and capabilities once. On success:
   - return the legacy hello-result shape to a legacy peer;
   - return the current result with selected revision, daemon supported range, package version, instance ID, and negotiated capabilities to a current peer;
   - then start the existing scoped replay forwarders.
7. On incompatibility, send one `INCOMPATIBLE_PROTOCOL` response with both ranges and close only that connection after the response is handed to the socket. Existing healthy clients and the shared coordinator/provider remain live.
8. Enforce negotiated capabilities on post-hello actions. A connection without `transport` must receive `UNSUPPORTED_CAPABILITY` and remain governed by normal connection-local policy; never submit the command to the coordinator.
9. Keep hello-first, second-hello rejection, strictly increasing request IDs, action validation, and seek validation. Do not change coordinator command/error behavior.
10. Construct status/state/response frames through the schema-owned wire constructors. Internal coordinator values are trusted, but the transport representation must have one schema-defined shape.
11. Preserve framing locality: malformed JSON, oversized input, blank frames, and incomplete EOF close only the offending connection. Do not add Phase 8 write-pressure or queue behavior.

### 4. Update the explicit client handshake only as far as negotiation requires

In `packages/music-core/session/client.ts`:

1. Keep this an explicit socket-path client. Do not add runtime discovery, auto-start, reconnect, retries, or daemon replacement.
2. Send the current advertised major/revision range and requested capabilities in hello. Production defaults request the existing baseline capabilities.
3. If test/version simulation needs overrides, add narrow optional client options for supported protocol range and requested capabilities. Validate those options before connecting.
4. Decode every daemon frame through the shared server-frame schema. Decode hello success through the current hello-result schema and verify:
   - the selected major matches what the client offered;
   - selected revision lies in the offered range;
   - returned capabilities are a subset of requested capabilities and include required `state-replay`.
5. Expose the selected revision (or negotiated protocol value) alongside existing `daemonInstanceId` and `negotiatedCapabilities` so later phases do not infer it from package version.
6. Preserve queued status/state frames arriving with hello. Do not expand this phase into Phase 3's response-correlation, pending-call settlement, listener-exception, stale-generation, or reconnect work.
7. If hello is incompatible, malformed, or semantically impossible, destroy the socket and return one `MusicSessionClientError` with the stable protocol code/message. Do not retry or start another process.
8. Keep command methods and disposal behavior otherwise unchanged, except for capability preflight if needed to prevent a knowingly unsupported transport write.

### 5. Keep framing shared and revision-neutral

In `packages/music-core/session/framing.ts` and `packages/music-core/tests/session-protocol.test.ts`:

1. Retain one NDJSON framer for both sides and one byte limit.
2. Preserve UTF-8 decoder state across chunks, multiple frames per chunk, blank/malformed JSON rejection, oversize rejection before unbounded retention, and incomplete-frame detection at EOF.
3. Change framing production code only if schema integration exposes a real defect. Revisions belong inside decoded frames, not in a second framing format.
4. Do not add compression, binary framing, write-pressure policy, or revision-specific framers.

### 6. Add focused protocol tests

In `packages/music-core/tests/session-protocol.test.ts`:

1. Replace the single “v1 hello” assumption with explicit legacy and current hello fixtures.
2. Prove schema rejection for malformed nested protocol range, hello, state, track, device, status, error, success/failure response, action, and seek values.
3. Prove additive unknown fields are tolerated where intended.
4. Prove range negotiation chooses the highest overlap and returns structured client/daemon details on disjoint major/ranges.
5. Prove capability intersection, required `state-replay`, optional `transport`, and unknown-capability handling.
6. Retain the focused UTF-8, split/multiple-frame, oversize, and incomplete-EOF tests.

### 7. Add focused real-socket compatibility tests

In `packages/music-core/tests/session-server.test.ts` and `packages/music-core/tests/session-client.test.ts`:

1. Use unique real Unix paths and the existing fake provider/server facade. Keep every new client/socket/server in the Phase 1 failure-safe `try/finally` ownership pattern.
2. Establish one current explicit client and one raw legacy client using the actual old hello shape. Assert both receive successful hello/replay from the same daemon instance and that provider subscription/acquisition remains one.
3. Emit one provider snapshot and prove both supported revisions receive it.
4. Connect a disjoint-range client. Assert one failure with:
   - `INCOMPATIBLE_PROTOCOL`;
   - both offered and daemon ranges;
   - actionable message;
   - closure of only that connection.
5. After the incompatible peer closes, emit another update or issue a valid request through the healthy current peer to prove the daemon and existing connection remain live.
6. Connect a state-only current client. Prove capability intersection succeeds, then prove a transport request is rejected before coordinator admission.
7. Cover malformed current hello range, missing required capability, second hello, non-increasing ID, invalid action/seek, oversized frame, and incomplete EOF with compact focused cases. Do not duplicate the complete server lifecycle matrix.
8. In client tests, prove current negotiation exposes selected revision/capabilities and that malformed or out-of-offer hello results fail once and destroy the socket. Defer general pending-request and generation behavior to Phase 3.
9. Use Node event promises or Effect `Deferred`/`Queue`/`Latch`; do not use arbitrary sleeps, `Date.now()` uniqueness, raw timers, or repeated `Effect.yieldNow`.

### 8. Keep the phase diff and Jujutsu workflow narrow

1. Format only touched files.
2. Run protocol/client/server focused tests before the package gate.
3. Run the complete `music-core` target set as regression evidence for the approved provider/coordinator/server baseline.
4. Inspect `jj diff --summary` and the exact diff. Preserve `.apnea/state.json`, `docs/music-session-architecture.html`, and unrelated changes.
5. Keep work in the current phase child for review. Do not run `git commit`, push, or `jj squash` during the coding round. After approval, use the run's prescribed `jj squash` step for only this reviewed phase.

## Acceptance checks

Phase 2 is done only when:

- Requests, events, responses, nested state, capabilities, ranges, selected revision, and stable errors have one Effect-Schema-owned wire definition; the old manual `record`/`player`/cast validation path is gone.
- Existing legacy major/minor `1.0` and the current range-advertising client negotiate supported revisions against one daemon, receive replay/live updates, and share one provider/coordinator.
- Negotiation selects the highest overlapping revision and deterministic capability intersection; package version does not affect compatibility.
- Disjoint major/ranges receive one actionable `INCOMPATIBLE_PROTOCOL` response containing both ranges, while healthy peers and the daemon remain live.
- Missing required replay capability and use of unnegotiated transport capability produce stable errors without coordinator admission.
- Hello-first ordering, second hello rejection, strictly increasing IDs, action/seek rules, malformed nested values, oversized frames, and incomplete EOF remain enforced at the shared boundary.
- The explicit current client validates and exposes negotiated revision/capabilities, but still performs no discovery, launch, retry, reconnect, or command replay.
- All new socket tests are failure-safe and deterministic; approved provider, coordinator, server lifecycle, cleanup, blocked-work, and late-write tests remain green without being redefined as Phase 2 acceptance.

## Verify commands

Run from the repository root:

```sh
bun test packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
jj diff --summary
```

Inspect the diff after the commands:

- product/test changes are confined to the allowed Phase 2 paths;
- `packages/music-core/session/protocol.ts` no longer contains parallel manual nested-state validators or unchecked boundary casts;
- no discovery, spawning, reconnect, idle, fan-out, artwork, host, manifest, or documentation code entered the phase;
- `.apnea/state.json` and unrelated dirty paths remain untouched.

## Dependencies

- Verified provider commit `e7103663` and coordinator commit `859fc01d`.
- Verified scoped-server commit `66bc1f91` plus approved process-boundary commit `e70641bc`.
- Current explicit Unix-socket server/client, NDJSON framer, fake provider, replay streams, and package-version diagnostic source.
- Repository-pinned Effect v4 `Schema` APIs and Bun/Node Unix-domain socket support.

## Non-goals

- Runtime-directory discovery, path ownership/permissions, stale endpoint handling, startup markers, daemon spawning, singleton races, or healthy-generation replacement policy beyond returning the negotiated incompatibility result.
- Reconnect, replacement generations, command indeterminacy refinements, command replay policy changes, idle shutdown, or lifecycle diagnostics expansion.
- Per-client/global load bounds, slow-reader coalescing, 24-client proof, artwork, or cache behavior.
- Provider retry/event semantics, coordinator authority/polling/reconciliation/FIFO changes, server lifecycle restructuring, blocked-work tests, late-write tests, or another cleanup audit.
- OpenCode/Pi migration, host UI behavior, public index/manifests, packing, smokes, READMEs, or architecture HTML.
- New source modules, publishing, committing, squashing before approval, pushing, opening a PR, editing `.apnea/state.json`, or resetting/cleaning unrelated worktree content.
