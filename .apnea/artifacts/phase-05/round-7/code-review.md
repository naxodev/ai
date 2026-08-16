---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 5 package remains aligned with the approved plan, and Round 7 stays within the allowed music-core server/client test scope.

## Findings

### High — Idle cleanup evidence asserts the opposite of the required selected-graph ordering

The expanded lifecycle test expects all three connection finalizers before coordinator finalization:

`connection → connection → connection → coordinator → provider → listener → unlink`

That is the normal pre-grace history after each negotiated client departs, but it does not prove the Phase 1 idle-shutdown order required by the package: coordinator → dependent connections → provider → listener/unlink. Idle can still have non-negotiated connection scopes (for example, the intentionally held pre-hello socket), so the non-client idle test should retain one such real connection through expiry and assert that the graph closes coordinator before that connection and provider afterward. Keep the historical negotiated departures separate from the active shutdown-order assertion.

### High — The same-generation reconnect case does not prove grace cancellation or absence of launch

`reconnecting before A's idle grace keeps the same generation` reconnects with a custom connector that calls `createMusicSessionClient` directly. It has no launcher path to count, and it asserts the socket only immediately after reconnect; it never advances/waits beyond A's old idle deadline. The test therefore passes even if the stale grace remains live and kills A shortly afterward, and “no B launch” is true by construction rather than observed through the existing Phase 3 startup workflow. Use `connectOrStartMusicSessionEffect` with a launcher counter, pass beyond the canceled deadline, and prove A remains live with zero launches.

### Medium — The post-join test does not exercise the ownership-transfer interruption race

The `onJoinCommitted` hook fires before the hello response, but the test first awaits `createMusicSessionClient`, which resolves only after the response/handshake completes. It then awaits the already-resolved hook Promise and disposes normally. Consequently it does not interrupt at the first boundary after the atomic join transfer as its comment claims; it only proves an ordinary completed client eventually leaves. Destroy the accepted socket from the commit hook/gate before normal post-hello work proceeds and assert exactly `[0, 1, 0]`.

### Medium — The signal case is not a signal-versus-idle race

The signal test emits `SIGTERM` immediately on the real clock, well before the 25 ms idle deadline, so only the signal is ready. It proves signal shutdown but not the package's narrow concurrent signal/idle winner case. The defect case does exercise defect precedence at the virtual deadline; add equivalent controlled readiness for signal versus idle and exact-once finalization.

## Resolved findings

Round 7 adds meaningful idle-specific A→B replacement evidence, defect precedence, stronger executable cleanup/diagnostic checks, and expanded exact-once lifecycle counters. The production configuration, join ownership, TestClock lifecycle, and non-client behavior fixes from Round 6 remain intact.

## Verification

The coder reports 7 focused idle tests, 104 combined client/server tests, and a passing 234-test build/typecheck/test/format/package matrix, plus raw-timer and diff checks. The remaining findings concern scenarios whose assertions do not yet establish the package's exact acceptance semantics.
