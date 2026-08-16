---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 7 package remains aligned with the approved plan. Round 4 is confined to an allowed coordinator source path, but the required Phase 7 tests remain absent.

## Findings

### Critical — Admission can still create an ownerless in-flight entry

The coordinator-scoped workflow fixes caller ownership after it has been forked, but admission and startup are not one interruption-safe operation. `Ref.modify` installs the Deferred at `packages/music-core/session/coordinator.ts:530-556`; the workflow is not forked until the later interruptible yield at line 625. If the requesting fiber is interrupted after admission but before `forkIn` executes, no workflow or finalizer owns the entry. Equal requests wait forever and the key permanently consumes capacity.

The workflow cleanup also handles typed failure and interruption, but not defects. A defective provider or malformed runtime `available` value that makes `Buffer.from` throw terminates the fork without completing/removing the Deferred. Use an uninterruptible admission-and-start boundary and an all-exit finalizer that conditionally completes/removes the exact Deferred for success, typed failure, interruption, and defect.

### High — Runtime provider results are decoded only permissively and may be cached malformed

`Buffer.from(outcome.value.base64, "base64")` at `packages/music-core/session/coordinator.ts:609-614` permissively decodes noncanonical base64 and only compares decoded byte length. It does not validate `ArtworkResultSchema`, canonical encoding, or nonempty data before `complete` caches the original value. A malformed provider/fake result can therefore become a settled cache hit and later fail client frame decoding. It can also allocate from an unexpectedly large string before establishing a bound.

Validate the provider result with the schema/canonical base64 and encoded-length bound before decoding or cache insertion, then compute exact decoded size without an over-limit allocation. Malformed results need a stable non-cached outcome.

### High — Impossible frame configuration still violates correlated outcome semantics

Configuration still derives `Math.max(1, floor((maxFrameBytes - 512) * 0.75))`. A tiny positive frame limit is therefore accepted even when neither an artwork response nor the server's `too-large` fallback can fit. The fallback then reaches the generic oversized-send close path rather than returning the required correlated result. The separate 256 KiB protocol ceiling also remains unreconciled with the effective config limit.

Reject impossible/reversed settings through `MusicSessionConfigError` before provider/listener acquisition and establish one validated payload/envelope/frame relationship.

### High — The required artwork acceptance matrix is still absent

No artwork-specific test was added. The test tree still has no coverage for exact native command and identity checks, malformed/canonical base64 boundaries, capability/protocol behavior, coordinator authority/deduplication/capacity/eviction/retry, interruption and shutdown finalization, real server correlation/non-interference, explicit disconnect/disposal, or reconnect-generation no-replay. The coder result acknowledges this residual risk.

In particular, deterministic tests must interrupt the admitting caller before workflow start, disconnect the first caller while joiners remain, close the coordinator with a blocked lookup, and inject malformed/defective provider output.

### Medium — Verification remains partial

Round 4 reports TypeScript, 88 existing client/coordinator tests, formatting of two files, and `git diff --check`. It does not report either required artwork-focused command, the broad five-suite run, the full Nx matrix after this change, the forbidden-boundary scan, or focused acceptance evidence.

## Resolved findings

Once started, a lookup is now forked into the coordinator scope rather than owned by the first connection. Normal completion/removal is conditional on the exact Deferred and uninterruptible, and decoded-size comparison is more accurate than Round 3's encoded-length approximation.
