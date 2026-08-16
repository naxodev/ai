---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 6 package is aligned with the approved plan's bounded 24-client fan-out slice. The implementation remains within the allowed music-core config/client/server/test paths and does not introduce later artwork or host work.

## Findings

### Critical — The defining paused-reader/backpressure acceptance is absent

No test pauses a negotiated reader, reaches the real Node `socket.write() === false` barrier, observes `onWriteBackpressure`, or verifies state coalescing while that writer is blocked. There is likewise no mandatory-outbound overflow test. The focused suite only covers frame-count overflow and healthy 24-client fan-out.

Phase 6 specifically requires proof that one paused reader cannot delay the other twenty-three, that its state storage remains latest-only, healthy commands/FIFO continue, and mandatory overflow disconnects only that peer. The coder result's platform-dependence note does not replace the required deterministic hook/latch evidence.

### High — Invalid `maxPendingRequests` opens a socket and then leaks it

`createMusicSessionClient` validates `maxPendingRequests` only after `net.createConnection` has completed (`packages/music-core/session/client.ts:526-571`). An invalid zero/negative/fractional/non-finite/unsafe option throws without destroying the newly connected pre-hello socket. That leaks client/server connection ownership until some unrelated shutdown and can interfere with idle lifetime. Validate the option before creating the socket (or close on every validation failure), and add the required invalid-option cases.

### High — The decoded-frame bound is checked only after allocating the oversized array

The server calls `framer.push(chunk)` first and only then tests `frames.length > maxFramesPerChunk` (`packages/music-core/session/server.ts:834-846`). A chunk containing many tiny lines therefore materializes and decodes the entire array before the configured limit is applied. This does not satisfy the package requirement that the total decoded array itself remain bounded. Enforce the limit during framing/decoding or otherwise stop accumulating once the configured count is reached.

### High — The 24-client failure cleanup can lose successful clients

The test correctly uses `Promise.allSettled`, but then iterates results and throws immediately on the first rejection. Fulfilled results appearing later in the settled array are never added to `clients` and therefore escape the `finally` disposal loop. Collect every fulfilled client first, retain all failures, and only then fail the test, as explicitly required by the package.

### High — Required local-overflow and global-worker recovery evidence is incomplete

The only abusive-peer test exceeds `maxFramesPerChunk`; it does not fill the bounded inbound chunk queue while a request is blocked. There is no correlated mandatory-response overflow, no state-coalescing assertion, and no real-server `SERVER_BUSY` test that exceeds one-active-plus-global-queue capacity and then proves accepted work and a later command succeed. Existing coordinator unit regressions and a two-command FIFO server test do not cover the new writer/connection interaction required here.

The 24-client test also omits negotiated-capability equality and cross-client commands while one peer is slow, both explicit acceptance checks.

## Verification

The coder reports 3 focused tests, 130 combined server/client/coordinator tests, and a passing 237-test build/typecheck/test/format/package matrix with timer and diff checks. Those commands are green, but the focused evidence does not cover the phase's central backpressure and overflow behavior.
