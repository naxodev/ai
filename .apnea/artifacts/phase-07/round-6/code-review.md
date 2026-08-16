---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 7 package remains aligned with the approved plan. Round 6 stays within the allowed coordinator source path, but phase acceptance remains incomplete.

## Findings

### High — Canonical bounded base64 is still not enforced by the schema/provider boundary

`ArtworkResultSchema` still checks only that `base64` is a nonempty string of at most 256 KiB. It accepts non-base64 and noncanonical encodings, contrary to the package's schema-owned validated result requirement.

The coordinator then passes provider output directly to permissive `Buffer.from(..., "base64")` (`packages/music-core/session/coordinator.ts:613-618`) before proving canonicality or an encoded-size bound. Malformed runtime values can be cached unchanged as `available`; unexpectedly large values can allocate before rejection. Add canonical base64 validation to the schema/shared decoder, establish the encoded bound before allocation, compute exact decoded size from validated padding, and cache only a successfully validated bounded result. Malformed native payloads must remain stable and non-cached.

### High — Impossible frame configurations still cannot return the promised correlated result

Configuration continues to accept tiny positive `maxFrameBytes` and clamp the effective native limit to one byte. For such settings, neither an artwork response nor the server's `too-large` fallback fits, so the generic outbound limit closes the connection instead of returning the required correlated outcome. The protocol's independent 256 KiB ceiling also remains inconsistent with the configured frame envelope.

Reject impossible/reversed payload-frame relationships through `MusicSessionConfigError` before graph acquisition and use one validated relationship among decoded bytes, encoded base64, response envelope, schema limit, and `maxFrameBytes`.

### High — The package-required artwork acceptance matrix remains absent

No artwork-specific tests were added. There is still no deterministic evidence for the native command and three identity checks, malformed/canonical base64 and exact byte boundaries, protocol negotiation, coordinator authority/deduplication/capacity/eviction/retry, admission/cancellation/shutdown, real server correlation and non-interference, explicit disconnect/disposal, or reconnect-generation no-replay.

Round 6 specifically needs tests proving interruption during admission cannot create an ownerless entry, disconnecting the first caller does not cancel joiners, and coordinator-scope shutdown settles blocked waiters.

### Medium — Verification is partial after the Round 6 source change

The coder result reports TypeScript, 23 existing coordinator tests, and `git diff --check`. It does not report the focused artwork command, broad five-suite run, full Nx build/typecheck/test/format/package matrix after this change, formatting, or boundary scan. Round 5's Nx run predates the Round 6 coordinator edit.

## Resolved findings

The admission-to-fork gap is now inside an uninterruptible mask, with caller interruptibility restored only while awaiting the shared Deferred. The coordinator-owned workflow also converts all causes into exact-Deferred cleanup, so the previously reported ownerless-entry and defect-stranding paths are addressed in the implementation. They still require deterministic acceptance tests.
