---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 7 package remains aligned with the approved native-artwork plan. Round 2 stays within allowed core source paths, but still adds no artwork-specific tests.

## Findings

### Critical — The new in-flight cache state is not interruption-safe or atomically capacity-bounded

The owner removes its entry only after `provider.nativeArtwork` returns normally through `Effect.match` (`packages/music-core/session/coordinator.ts:553-570`). If the owning connection/scope is interrupted while the native read is blocked, the entry and unresolved `Deferred` remain forever. Later equal requests hang on that Deferred and distinct requests permanently lose capacity.

Settled cache and in-flight work are also separate `Ref`s with non-atomic transitions. The owner removes in-flight before inserting the settled result; another request can enter that gap and start a duplicate read. A stale `cached` snapshot is used inside the later in-flight `Ref.modify`, so concurrent completion/admission can exceed the shared budget. Conversely, once settled cache reaches capacity, every new distinct identity is rejected as busy before provider work, making deterministic eviction/re-read impossible; the eviction loop cannot admit the new key.

Use one scoped atomic state for settled and in-flight entries, define an interruption-safe owner finalizer that removes/completes the Deferred on every exit, and atomically implement hit/join/admit/evict/complete. Prove equal-key sharing, interruption, capacity, eviction, and failure retry.

### High — Explicit `artwork()` bypasses existing client lifecycle and request-ID guards

Unlike transport `request()`, `Client.artwork()` does not reject when the client is terminal/disposed, does not check request-ID exhaustion, and writes without an error callback (`packages/music-core/session/client.ts:382-425`). Calling artwork after terminal/disposal can allocate a pending request against a destroyed socket and leave its Promise unsettled; asynchronous write failure may likewise miss truthful settlement. Apply the same phase/disposal, pending-capacity, request-ID, and write-error admission boundary used by transport, while retaining artwork-specific `CONNECTION_LOST` semantics.

### High — Payload/frame truthfulness remains incomplete

Round 2 leaves the configuration relationship unchanged: impossible small `maxFrameBytes` values are clamped to a one-byte native limit rather than rejected, and the effective limit is not reconciled with `ArtworkResultSchema`'s separate 256 KiB base64 ceiling. The coder result explicitly acknowledges this residual issue.

The final server fallback is useful, but a provider/fake can return an unvalidated oversized `available` value that the coordinator caches before the server converts the wire response to `too-large`. Validate the provider result against the effective bound before cache insertion, and ensure one consistent config/schema/wire maximum. Impossible settings must fail before graph acquisition.

### High — The required artwork test matrix is still absent

No tests changed in Round 2. There is still no focused evidence for native command/identity/base64 boundaries, protocol schemas/capability behavior, coordinator pre/post authority, deduplication/capacity/eviction/interruption/retry, real server correlation/non-interference, client disconnect/disposal, or managed-generation no-replay. The coder result acknowledges this directly. Baseline suites cannot validate new artwork behavior.

## Resolved findings

Round 2 now requires a nonempty artwork ID, handles non-object JSON as unavailable, rejects missing native IDs as stale, checks canonical base64 after a bounded size calculation, and adds a final server response fallback to `too-large`.

## Verification

The broad five-suite run reports 185 passing tests, and the exact 242-test Nx matrix now passes with build, typecheck, format, and package checks. Verification is green for existing coverage, but the phase-specific acceptance remains untested and the concurrency/lifecycle defects above remain.
