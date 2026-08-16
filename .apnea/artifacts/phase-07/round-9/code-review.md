---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 7 package remains aligned with the approved plan. Round 9 adds an allowed protocol test, but the phase remains materially short of its acceptance package.

## Findings

### High — Payload schema, configuration, and frame limits remain inconsistent

The independent 256 KiB encoded ceiling in `ArtworkResultSchema` is still not reconciled with configured decoded bytes and `maxFrameBytes`. A valid result allowed by large runtime limits can be rejected as `unavailable`; tiny positive frames remain accepted even when the correlated `too-large` fallback cannot fit and the generic writer closes the connection.

Establish one validated schema/config/envelope relationship. Reject impossible/reversed settings through `MusicSessionConfigError` before graph acquisition, and prove payload excess always returns correlated `too-large` rather than `unavailable` or connection loss.

### High — Most of the required Phase 7 acceptance matrix is still absent

Round 9 adds useful canonical-base64 schema cases, but no tests cover the core vertical behavior:

- exact `media-control get --now`, all native identity mismatches, malformed JSON, unavailable/timeout/failure, and decoded boundary/one-byte-over-limit behavior;
- artwork request identity bounds, capability negotiation, request-ID handling, and old-peer health;
- coordinator pre/post authority, equal-key deduplication, distinct-key capacity, eviction/re-read, failure retry, admission interruption, first-caller disconnect, and coordinator shutdown;
- real server correlation, final response containment, state/command progress during a blocked read, and connection isolation;
- explicit client disconnect/disposal and reconnect-generation no-replay.

Add deterministic provider controls and focused tests across the package-listed modules. One protocol schema test does not satisfy the end-to-end acceptance gate.

### Medium — Verification remains partial

Round 9 reports only the nine-test protocol file and `git diff --check`. It does not report the package's focused four-file artwork command, broad five-suite run, full Nx build/typecheck/test/format/package matrix after the test change, or boundary scan.

## Resolved findings

The protocol test now proves acceptance of canonical `AQ==` and rejection of invalid length, padding, alphabet, noncanonical trailing bits, and over-schema-limit values. Together with Round 8's internal length guard, this addresses the bounded canonical schema finding at the protocol level.
