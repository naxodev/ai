---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 7 package remains aligned with the approved plan. Round 8 is confined to an allowed protocol path, but phase acceptance is still incomplete.

## Findings

### High — Payload schema, configuration, and frame limits remain inconsistent

`ArtworkResultSchema` still has an independent 256 KiB encoded ceiling, while configuration derives `nativeArtworkMaxBytes` from `maxFrameBytes` with a separate approximation. A valid result permitted by a large configured native/frame limit can exceed the schema ceiling and be converted to `unavailable` rather than returned. Conversely, tiny positive frame limits are accepted and clamped to one decoded byte even when the correlated `too-large` response itself cannot fit, causing the generic outbound path to close the connection.

Define one validated relationship among schema encoded length, exact decoded bytes, response envelope, and `maxFrameBytes`. Reject impossible/reversed settings through `MusicSessionConfigError` before listener/provider acquisition, and ensure all payload excess produces correlated `too-large` rather than `unavailable` or connection loss.

### High — The required Phase 7 artwork test matrix remains absent

No tests changed in Round 8. There is still no focused evidence for:

- exact native command, complete identity matching, malformed JSON/base64, unavailable/failure, and exact byte boundaries;
- protocol schema/capability behavior and older-peer health;
- coordinator pre/post authority, deduplication, finite admission, eviction/re-read, failure retry, admission interruption, caller disconnect, and coordinator shutdown;
- real server correlation and state/command non-interference;
- explicit client disconnect/disposal and reconnect-generation no-replay.

Add the deterministic fake controls and tests required by the package. The focused verify command must exercise substantive artwork cases rather than baseline capability/payload tests.

### Medium — Verification is partial after the protocol change

Round 8 reports TypeScript and eight existing protocol tests only. It does not report the focused artwork command, broad five-suite run, full Nx build/typecheck/test/format/package matrix after this edit, formatting check, boundary scan, or `git diff --check` in the coder result.

## Resolved findings

The canonical schema filter now checks its own encoded length and shape before `Buffer.from`, so Effect Schema's accumulated failures cannot trigger an over-limit decode allocation. Canonical round-trip allocation is bounded to 256 KiB. This implementation fix still needs explicit over-limit/canonical schema tests.
