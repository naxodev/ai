---
status: done
verdict: CHANGES_REQUIRED
---

# Findings

The phase package remains aligned with the approved Phase 1 plan. The prior marker-generation, coordinator-boundary, and exact OpenCode blockers are addressed, but one implementation issue remains.

## Medium — UTF-8 truncation can exceed the 512-byte diagnostic limit

`packages/music-core/session/client.ts:975` caps the retained `Buffer` at 512 bytes and then converts it with `diagnostic.toString("utf8")`. If the cap splits a valid multibyte character, Node replaces the incomplete suffix with U+FFFD; re-encoding the exposed diagnostic can therefore exceed 512 bytes. For example, a daemon-prefixed line whose 512-byte boundary contains the first two bytes of an emoji produces a 513-byte returned string. The test at `packages/music-core/tests/session-client.test.ts:1376` uses ASCII only, so it does not cover this case.

The phase contract bounds the host-visible diagnostic to at most 512 bytes while explicitly treating stderr as bytes. Truncate on a valid UTF-8 boundary or apply a final encoded-byte bound after decoding, and add a multibyte boundary regression asserting the returned diagnostic remains daemon-prefixed, valid, and no more than 512 bytes.
