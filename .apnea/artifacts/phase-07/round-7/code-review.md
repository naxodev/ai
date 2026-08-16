---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 7 package remains aligned with the approved plan. Round 7 stays within allowed protocol/coordinator paths, but the package acceptance matrix remains absent.

## Findings

### High — The schema still allocates before its encoded bound is established

`CanonicalBase64` places `isMaxLength` and the canonical round-trip in the same non-aborting check group (`packages/music-core/session/protocol.ts:148-158`). For an over-limit string containing valid alphabet characters with divisible length, the custom filter still executes `Buffer.from(value, "base64")` even though `isMaxLength` has failed. A malformed/additive provider can therefore force an allocation proportional to its untrusted result before the coordinator maps decoding failure to `unavailable`.

Make the canonical filter itself reject on encoded length before regex/round-trip work, or use an aborting bounded check. Prefer canonical alphabet/padding plus exact decoded-size arithmetic without decoding solely for validation. Add an over-schema-limit provider-result test proving no decode/allocation path runs.

### High — Schema, configured payload, and frame limits remain inconsistent

The hard-coded 256 KiB encoded schema ceiling is not derived from or validated against `nativeArtworkMaxBytes` and `maxFrameBytes`. With a large valid frame/native limit, an otherwise valid bounded provider result above 256 KiB encoded is converted to `unavailable`; with a tiny frame, configuration still clamps to one decoded byte even when the correlated `too-large` response itself cannot fit and the connection closes.

Reject impossible settings through `MusicSessionConfigError` before graph acquisition and establish one validated relationship among schema encoded length, exact decoded bytes, response envelope, and `maxFrameBytes`. Oversize relative to that relationship must return correlated `too-large`, not `unavailable` or connection loss.

### High — The required artwork acceptance matrix is still absent

No artwork-specific tests were added. There remains no deterministic coverage for:

- exact `media-control get --now`, every identity mismatch, malformed JSON/base64, unavailable/failure, and exact byte boundaries;
- protocol capability and schema behavior;
- coordinator pre/post authority, equal-key sharing, finite distinct-key admission, eviction/re-read, failure retry, admission interruption, caller disconnect, and scope shutdown;
- real server correlation/non-interference and unsupported-peer health;
- explicit disconnect/disposal and reconnect-generation no-replay.

The 242-test baseline cannot establish Phase 7 behavior when the focused test filter still matches no substantive artwork tests.

## Verification

Round 7 reports a green TypeScript/full Nx matrix and `git diff --check`. Existing coverage is green, but the phase-specific verify command, broad five-suite artwork acceptance, and deterministic controls/evidence required by the package are still missing.

## Resolved findings

Canonical base64 is now part of `ArtworkResultSchema`, and the coordinator schema-decodes provider results before cache insertion. For schema-valid data it computes exact decoded size from padding without decoding and maps over-limit data to `too-large`; malformed results are not cached as available.
