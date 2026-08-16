---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 2 package matches the approved plan. The implementation is test-only, uses two real `runMusicSessionDaemon` children and one explicit socket, and does not introduce startup-marker, `connectOrStart`, `TestClock`, convergence, or incompatibility work.

## Findings

### High — Hung contender exits bypass the promised failure-safe cleanup

`packages/music-core/tests/session-server.test.ts:1332` awaits the presumed loser's exit without a bound, and lines 1390-1393 do the same after signaling the winner. If both children claim listening, the loser fails to terminate, or the winner ignores shutdown, the async test remains suspended before entering `finally`; Bun's outer test timeout cannot inject an exception into that pending `await`, so the children/readers/socket directory are not unconditionally released. This directly misses the package requirement that both-listen and hung-child failures still reach cleanup. Bound the expected loser and winner exits (and associated collection) with a sentinel that throws into this test's own control flow so `finally` kills and awaits both processes.

### Medium — The pre-existing winner client is not shown to remain live after loser exit

After the loser exits, line 1372 only re-reads `firstClient.status`, which is cached and remains `ready` even after this client has terminated. The second client's successful hello proves that the listener/path survived, but not the package's separate assertion that the already-connected client remains healthy. Exercise a real post-loser operation through `firstClient` (or otherwise observe live traffic on that exact connection) before disposing it.

## Verification

The coder supplied passing happy-path evidence: the focused contender test, all 36 server tests, all `music-core` build/typecheck/test/format/package targets with 204 tests, exact diff inspection, and `git diff --check`. Those runs do not exercise the required hung-child cleanup branches or establish liveness of the first connection after loser exit.
