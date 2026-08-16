---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package remains aligned with the approved plan, and Round 6 remains within its allowed client scope. The ownership, generation, listener, and lifecycle-value transitions are now substantially moved to atomic `Ref.modify` operations, and the full verification evidence is fresh.

## Findings

### High — Disposal ownership remains outside the synchronized lifecycle and can be started reentrantly more than once

Round 5 specifically identified `#interrupt`, `#closeScope`, and `#dispose` as unsynchronized disposal ownership. They remain ordinary mutable fields at `packages/music-core/session/client.ts:1115-1117`, and `dispose()` still performs a check-then-call-then-assign sequence at lines 1480-1489. The selected closer is invoked while `#dispose` is still undefined because the right-hand side is evaluated before assignment.

That leaves a concrete reentrancy window: `Scope.close`/`Fiber.interrupt` can run `shutdown()` synchronously enough to publish `disposed`; a lifecycle listener can call `dispose()` from that notification before the outer call has assigned `#dispose`, starting a second close/interrupt operation and returning a different completion. This fails the package's requirement for idempotent asynchronous disposal under the same Effect synchronization policy, even though `shutdown()` itself is now atomic.

Reserve disposal exactly once in the lifecycle `Ref` (for example, with a `Deferred` completion and an atomic started flag/owner extraction), invoke the closer only for the winning transition, and have all concurrent or reentrant callers await that one completion. Add a deterministic reentrant/concurrent disposal assertion that proves the closer starts once and every call completes only after the owned scope/fiber is closed.

## Verification

The focused suite reports 11 passing tests, the direct client/server run reports 96 passing tests, and the uncached full target reports 226 tests and 953 expectations with build, typecheck, format, and package checks passing. This resolves the stale-evidence finding; no verification failure was reported.
