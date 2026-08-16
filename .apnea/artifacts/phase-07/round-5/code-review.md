---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 7 package remains aligned with the approved plan. Round 5 retained no source or test changes, so it does not address the prior gate.

## Findings

### Critical — In-flight admission can still create an ownerless entry

The Round 4 critical finding remains unchanged. Coordinator admission installs the Deferred in `artworkStore` before the separate interruptible `Effect.forkIn` operation (`packages/music-core/session/coordinator.ts:530-556,625`). Interruption between those operations leaves no workflow to complete or remove the entry, so equal requests hang and capacity is permanently consumed.

The forked workflow still has no all-exit cleanup for defects. A defective provider or malformed runtime result that defects during validation terminates the fiber without settling waiters or removing ownership. Admission and coordinator-scoped startup must be interruption-safe as one boundary, and exact-Deferred cleanup must cover success, typed failure, interruption, and defect.

### High — Provider-result validation remains permissive and cache-unsafe

The coordinator still passes provider base64 directly to permissive `Buffer.from` before schema/canonical validation. Malformed or unexpectedly large runtime values can defect, allocate before a proven encoded bound, or be cached as `available`. Validate the schema and canonical base64 within the effective bound before decoding/cache insertion, with malformed results remaining non-cached stable outcomes.

### High — Impossible frame settings remain accepted

Tiny positive `maxFrameBytes` values are still converted into a one-byte artwork limit even when neither a normal response nor the correlated `too-large` fallback can fit. The separate protocol base64 ceiling is also not reconciled with the runtime envelope limit. Reject impossible settings before graph acquisition and enforce one payload/frame relationship.

### High — The Phase 7 artwork acceptance matrix is still absent

No tests changed. Required native adapter, protocol, coordinator, server, explicit client, reconnect generation, cancellation, cache, payload-boundary, and blocked-read non-interference evidence remains missing. In particular, there is no deterministic test for the admission/start interruption gap that blocks approval.

## Verification

Round 5 reports a green full Nx matrix with 242 existing tests. `jj diff` confirms no `packages/music-core` changes relative to Round 4. The baseline matrix is green, but it cannot resolve the unimplemented findings or replace the package-required artwork acceptance tests.
