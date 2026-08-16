---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package is aligned with the approved plan: it is limited to truthful explicit-client request/stream semantics, one transport-result schema addition, focused client tests, and the affected server assertion. The diff remains within its allowed paths.

## Findings

### High — The handshake-to-active listener gap remains unchanged

The required lifetime reader refactor was not implemented. Handshake still calls `cleanup()` before resolving, `createMusicSessionClient()` awaits that Promise, constructs `Client`, and only then calls `attach()`. Frames arriving in that interval have no `data` listener and can be lost. `attach()` also installs anonymous `data`/`error`/`close` callbacks, has no `end` handler or `NdjsonFramer.end()` call, and neither terminal transition nor disposal can remove those exact listeners. Clean EOF with a buffered partial frame therefore cannot be classified as invalid daemon data as required.

Use one set of owned callback references and one handshaking/active/terminal state machine from connection through teardown; transition to active before exposing readiness and detach every listener exactly once.

### High — Terminal state is not truthful for clean close and does not suppress late frames

The active `close` callback calls `terminate()` with `INDETERMINATE_COMMAND`. `terminate()` stores that same error in `#failure`, so future calls after a clean close incorrectly reject as `INDETERMINATE_COMMAND` rather than `CONNECTION_LOST`. Only pending calls should receive the indeterminate error.

Additionally, `receive()` has no terminal/disposed guard. Because socket listeners are left attached, a late data callback after termination/disposal can still mutate cached status/state. `subscribeStatus()` and `subscribeState()` also accept new listeners after terminal/disposed state and may immediately invoke them from that cache, violating the no-listener-after-terminal contract.

### High — Most Phase 3 acceptance evidence is absent

Only reverse-order settlement of two valid transport responses was added. There is no deterministic coverage for:

- unsolicited and duplicate responses followed by newer requests;
- malformed or mismatched transport success data;
- request-local typed failure followed by a successful command;
- error/end/close races, future `CONNECTION_LOST`, and no replay/second connection;
- repeated disposal, pending/future `DISPOSED`, and late callbacks;
- invalid seek sending no frame;
- wrong-instance, duplicate, stale, and out-of-order state authority;
- throwing/self-unsubscribing/idempotently unsubscribed listeners and late subscription;
- malformed nested frames, split/multiple frames, partial EOF, and no handshake reader gap.

The reported 41 focused tests therefore do not establish the package's request, terminal, stream-authority, and listener acceptance checks.

### Medium — Listener delivery still iterates the live set

Status/state publication uses `for (const listener of this.#...Listeners)` directly. A listener that removes another listener during delivery can alter which callbacks receive the current accepted frame. Iterate a stable snapshot and retain per-callback exception isolation as the package requires.

## Verification

The coder reports all focused tests, 163 music-core tests, package contents, build, typecheck, format, and static scans passing. Those are valid regressions, but they do not cover the missing product semantics above.
