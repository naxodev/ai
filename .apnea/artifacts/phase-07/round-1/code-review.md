---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 7 package is a coherent elaboration of the approved native-artwork plan and remains isolated from host presentation/cutover work. The implementation touches only allowed core paths.

## Findings

### Critical — Artwork lookups have neither in-flight deduplication nor an in-flight capacity bound

`MusicSessionCoordinator.artwork` checks the settled `Map`, then directly runs `provider.nativeArtwork` for every miss (`packages/music-core/session/coordinator.ts:505-529`). Concurrent equal identities therefore execute duplicate native reads, while concurrent distinct misses create one provider effect per request with no cache-capacity admission. The configured capacity applies only after successful completion and cannot bound in-flight work.

This violates the central phase acceptance and is acknowledged in the coder result. Add scoped in-flight ownership keyed by the complete identity, atomically share equal-key effects, bound distinct in-flight plus settled entries, remove interrupted/failed/stale/too-large work, and prove deduplication, capacity eviction/admission, retry after failure, and shutdown interruption.

### High — Native decoding accepts missing IDs and does not defensively handle malformed objects/base64

`ArtworkIdentitySchema` permits empty identity strings, and the native comparison maps a missing `contentItemIdentifier` to `""`. If both authoritative/requested and native IDs are empty, title/artist matches can return artwork, contrary to the requirement that missing IDs never be rescued by title. Require a nonempty provider/content ID and return stale when the native ID is missing.

After `JSON.parse`, the code casts directly to `MediaGet`; JSON `null` causes a property-access defect and becomes `PROVIDER_FAILURE` instead of the required malformed/unavailable outcome. The base64 regex/length check also does not establish canonical encoding (non-zero discarded padding bits are accepted). Validate the object shape and verify canonical base64 without allocating decoded bytes until the computed size is within the configured limit.

### High — Payload/frame configuration and final response containment are not truthful for all valid settings

The effective byte calculation clamps to at least one byte even when `maxFrameBytes <= 512`, rather than rejecting an impossible envelope relationship. It also does not reconcile configured limits with the protocol schema's separate hard-coded 256 KiB base64 maximum. Valid configuration can therefore produce an `available` value that either cannot fit the mandatory frame or cannot be decoded by the client.

The server sends the artwork result through generic `send`; if the final encoded response still exceeds `maxFrameBytes`, Phase 6 closes the connection instead of returning the required correlated `too-large` outcome. Validate/derive one consistent schema/config/frame bound before graph acquisition and add a final response-size fallback to `too-large`.

### High — The required artwork acceptance matrix is almost entirely absent

Only `session-client.test.ts` changed, by one fixture method, and the focused command reports one matching test. No new system-media, protocol, coordinator, or real server artwork tests were added. Missing evidence includes exact `media-control get --now`, all identity mismatches, malformed/canonical base64, byte boundaries, unavailable/failure behavior, pre/post authority checks, cache/dedup/eviction/retry/cancellation, capability rejection, real correlated results, blocked-artwork state/command progress, disconnect/disposal, and late generation-A completion.

These are explicit package acceptance checks, not optional follow-up work. The coder result also acknowledges the absent fake-provider controls and end-to-end matrix.

### Medium — The required full verification matrix is not green after final formatting

The reported Nx matrix exits 1 because `format:check` failed. A direct Prettier check was run after formatting, but the exact build/typecheck/test/format/package command was not rerun on the final tree. Supply a successful full matrix after the substantive fixes.

## Verification

The broad five-suite run reports 185 passing tests and direct TypeScript/Prettier checks pass. Those are baseline regressions; they do not exercise the new artwork behavior described above.
