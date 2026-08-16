---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package remains aligned with the approved plan. The rework stays within the allowed client and client-test paths and does not introduce later-phase behavior.

## Findings

### Critical — Disposal can still leak a client that completes after interrupted connection acquisition

The new ownership bracket uses `Effect.acquireRelease(..., { interruptible: true })` at `packages/music-core/session/client.ts:1248-1256`. With an interruptible acquisition, the finalizer is registered only if the connector succeeds before interruption. The production connector ultimately crosses non-cancelable Promise/socket boundaries; if disposal interrupts the fiber and that Promise later resolves with a handshaken explicit client, the success is discarded before `acquireRelease` registers its release, so the client is never adopted or disposed.

The new disposal test only uses an interruptible `Effect.sleep` that never produces a late client, so it cannot detect this handoff leak. Add a connector that actually completes with a controllable client after disposal and prove that client is disposed, then make the acquisition/cancellation boundary own that late success without preventing prompt interruption.

### High — Explicit disposal after terminal does not publish disposed semantics

Natural supervisor completion now correctly retains terminal state. However, `shutdown()` publishes `disposed` only when `#terminal` is absent (`client.ts:1194-1204`). After replacement incompatibility/runtime failure, a later caller or scope disposal sets `#disposed` and clears listeners but leaves `connection` as `terminal`; the public lifecycle never records the explicit disposal. Natural termination should retain terminal until disposal, while actual caller/scope disposal should transition to the contract's disposed state. Add this lifecycle case to the terminal tests.

### High — Required old-generation and retained-listener race evidence is still missing

The added tests cover replacement terminal errors, bounded scheduling, and cancellation of a sleep, but the package still requires independently controllable late A state/status/terminal/response callbacks after B adoption. `scriptedGeneration` only controls terminal delivery and cannot emit state/status or late command completion. There is also no assertion that retained **status** replays during reconnect or that late/unsubscribed old-generation listeners cannot mutate B. Complete this generation-fencing/listener matrix rather than relying only on real socket closure, which removes the old callbacks before they can race.

## Verification

The coder supplied passing focused, combined, full-target, timer-scan, and diff evidence (7 focused tests, 92 combined tests, 222 full tests). Those tests do not exercise a late successful connector after cancellation or the remaining old-generation callback cases above.
