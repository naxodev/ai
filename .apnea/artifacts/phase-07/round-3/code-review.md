---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 7 package remains aligned with the approved native-artwork plan. Round 3 stays within allowed client/coordinator source paths but still adds no phase-specific tests.

## Findings

### Critical — Shared in-flight ownership can still strand joiners on interruption

The in-flight maps are now atomic and capacity-bounded, but the native lookup itself still executes in the first requesting connection's fiber rather than coordinator-scoped supervised ownership. Disconnecting/interruption of that owner cancels the lookup for every joined caller, contrary to the package's coordinator-owned shared lookup semantics.

More directly, `Effect.onInterrupt` wraps only `provider.nativeArtwork` (`packages/music-core/session/coordinator.ts:578-594`). Interruption after the provider effect succeeds—during the subsequent authoritative read, store update, or Deferred completion—does not run `remove`. The store can retain an unresolved in-flight entry forever. There is also a gap after the store removes the entry/inserts cache at lines 609-615 but before `Deferred.succeed` at line 616; interruption there leaves existing joiners hung even though future calls hit the cache.

Own the lookup in the coordinator scope (for example, a scoped FiberSet), make the complete provider → post-check → store transition → Deferred completion workflow exit-safe, and perform store removal plus waiter completion uninterruptibly with deferred-identity checks. Coordinator shutdown should be the authority that interrupts the shared lookup; one caller disappearing must not strand or incorrectly own other callers.

### High — Provider-result and frame-limit validation is still inconsistent

The new coordinator guard compares base64 string bytes with `ceil(maxBytes / 3) * 4`. That does not validate decoded size: for `maxBytes = 1`, canonical `"AAAA"` passes the four-character limit but decodes to three bytes. It also does not schema-validate canonical base64/provider output before caching, so an additive fake/provider can put malformed `available` data into the settled cache and cause client decode/connection failure.

The prior configuration issue remains: impossible tiny `maxFrameBytes` relationships are clamped to a one-byte native limit instead of rejected, and the effective config maximum is not unified with `ArtworkResultSchema`'s separate base64 ceiling. Validate one canonical result/decoded-size bound before cache insertion and reject impossible config before graph acquisition.

### High — The artwork acceptance matrix remains entirely absent

No tests changed in Round 3. Required evidence is still missing for native command/identity/base64 boundaries, protocol capability/schema behavior, coordinator pre/post authority, equal-key sharing, capacity/eviction, failure retry, owner/joiner cancellation, real server correlation/non-interference, explicit disconnect/disposal, and managed generation no-replay. The coder result explicitly acknowledges this.

The concurrency implementation cannot be accepted without deterministic tests that force the interruption gaps described above.

### Medium — Verification is partial for the changed tree

Round 3 reports TypeScript, `git diff --check`, and 88 client/coordinator tests. It does not report the required focused artwork command, broad five-suite run, full Nx build/typecheck/test/format/package matrix, boundary scan, or exact phase diff after these source changes.

## Resolved findings

Client artwork admission now applies disposal/terminal, pending-capacity, request-ID exhaustion, and asynchronous write-error guards. The combined settled/in-flight store also makes normal hit/join/admit/evict transitions finite and atomic.
