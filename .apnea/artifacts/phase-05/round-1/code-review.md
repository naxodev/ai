---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 5 package is a narrower elaboration of the approved plan's zero-client idle-shutdown phase. It remains appropriately isolated from Phase 6 fan-out and later artwork/host work.

## Findings

### Critical — Negotiated join can be recorded without its matching leave

The connection processes a compatible hello with `yield* onJoin` and only afterward sets the plain `joined` flag (`packages/music-core/session/server.ts:619-620`). `onJoin` is an interruptible queue offer. If the connection is interrupted after the offer succeeds but before the generator resumes to assign `joined = true`—for example, an immediate socket close wakes the connection completion path—the connection finalizer observes `joined === false` and omits `onLeave`. The supervisor then retains a phantom client count and the daemon can never enter zero-client grace.

Make successful queue enrollment and the finalizer's joined ownership one interruption-safe transition, and add a deterministic immediate-disconnect race proving every accepted join has exactly one leave.

### High — Most Phase 5 acceptance is explicitly unproven

The only focused idle test exercises the initial zero-client sleep and expiry. It does not use a real client hello and does not cover the package's required cancellation/restart state machine. Missing deterministic evidence includes:

- compatible join cancellation, two-client/non-last departure, last departure, rejoin cancellation, and a fresh exact-once expiry;
- raw pre-hello, malformed, and incompatible sockets failing to pin the daemon;
- exact Phase 1 shutdown ordering and owned socket/bind-reservation cleanup on idle;
- signal-versus-idle and defect-versus-idle winner behavior without duplicate cleanup or masked defects;
- real executable no-client status-zero exit and bounded process/signal/artifact cleanup;
- managed reconnect rejoining A before grace and adopting B after A genuinely idles out, with retained state and no command replay;
- bounded lifecycle diagnostic contents and absence of playback payloads.

These are explicit package acceptance checks, not optional broader coverage. The coder result also acknowledges that this matrix and reconnect interaction remain unproven.

### High — `idleGraceMs` is missing from the environment-backed Config layer

The existing `MusicSessionConfigLive` layer exposes the runtime timing settings through `Config`, but it has no `idleGraceMs` entry and does not pass that value to `resolve` (`packages/music-core/session/config.ts:300-371`). Production is therefore fixed to the hard-coded default rather than receiving the package-required matching validated Config setting. Add the environment-backed entry alongside the other timings and focused default/override/invalid-value evidence.

## Verification

The supplied commands pass: 1 focused idle test, 98 combined client/server tests, and an uncached full matrix of 228 tests/966 expectations. Those green regressions do not substitute for the missing Phase 5 acceptance evidence above.
