---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package is aligned with the approved plan and correctly confines this gate to foreground server/connection ownership without expanding the protocol or client. The implementation changes stay in allowed paths, but the required ownership and failure matrix is substantially incomplete.

## Findings

### High — The focused suite does not establish Phase 3 ownership or failure semantics

`session-server.test.ts` still has only the four pre-existing facade-level integration tests. It has no deterministic lifecycle hooks or direct Layer graph evidence, and does not cover mid-frame/natural disconnects, blocked command or sample shutdown, acceptance-vs-close, healthy-peer isolation, occupied-path safety, post-bind errors, injected close/unlink failures, `ENOENT`, cleanup-failure idempotency, signal-handler cleanup, or exact forwarding/connection finalization. Assertions such as `socket.destroyed` and legacy-provider aggregate disposal counts cannot prove child connection scopes and forwarding fibers were awaited. The package explicitly requires these cases before acceptance, and the coder result acknowledges they remain for later rounds.

### High — Post-bind server errors are silently swallowed

The persistent `onServerError` callback in `server.ts:338-341` is a no-op. It prevents Node's unhandled-error crash but never routes the failure into the server Effect lifetime as a tagged `MusicSessionSocketError`, so the Layer, Promise facade, and executable cannot observe a listener failure after bind. This directly violates the required socket boundary.

### High — Failed listener acquisition leaks its partial server ownership

The persistent error listener is installed before `listen` inside the acquisition effect (`server.ts:342-345`), but `acquireRelease` registers its finalizer only after acquisition succeeds. If `listen` fails, no release runs to remove `onServerError` or close the unbound/partially bound `net.Server`. The package requires cleanup of temporary and persistent listeners and partial listener state on startup failure while preserving the tagged listen error.

### High — Shutdown neither explicitly awaits connection supervision nor reuses failed outcomes

The server finalizer destroys sockets and immediately proceeds to remove the server listener, close the listener, and unlink (`server.ts:346-363`). The `FiberSet` is scoped outside that acquisition and is not explicitly interrupted/awaited before listener/path teardown; its scope finalizer runs separately, so the stated dependency order is not established. In the Promise facade, `closed` is set before awaiting `Scope.close` (`server.ts:392-397`), meaning a failed first `close()` rejects once but every later call returns success instead of reusing the same typed failure. Both behaviors contradict the package's ordered, idempotent cleanup contract.

## Verification

The reported green baseline is reproducible: 4 server tests, 65 coordinator/provider tests, and all static scans pass. Those checks do not cover the findings above.
