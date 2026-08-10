---
status: done
---

# Phase 1 coder result (round 2)

## What changed

Fixed the High finding from round-1 code review: partial stream payloads were treated as authoritative snapshots.

`isAuthoritativeMediaPayload` now requires the complete sample shape with correct types:

- present `title`, `artist`, `album` as `string | null`
- present finite `duration` as `number | null`
- present boolean `playing`
- present `contentItemIdentifier` as `string | number | null`
- present `elapsedTime` and/or `elapsedTimeNow` as finite `number | null`

Empty or null values remain valid for complete idle samples. Boolean-only payloads such as `{ "playing": false }` and identity-only payloads such as `{ "title": "Song" }` emit nothing, do not mutate the clock, and do not reset retry backoff.

Idle decoding now stamps `fetched_at` from the shared arrival timestamp instead of a fresh `Date.now()` inside `emptyPlayer()`.

## Files touched

- `packages/music-core/system-media.ts`
- `packages/music-core/tests/system-media.test.ts`

## Verify transcript

Command:

```sh
bunx nx run-many -t typecheck test format:check package:check --projects=music-core
```

Exit code: `0`

Tail:

```
✓ media-control stream subscription > ignores malformed, non-data, and incomplete envelopes then accepts a valid one
✓ media-control stream subscription > emits idle from a complete payload with empty identity values
✓ media-control stream subscription > supports listeners that ignore the event argument
✓ media-control stream subscription > terminal error/exit/close emit one immediate invalidation and one restart
✓ media-control stream subscription > retry delays cap at 1/2/4/8 seconds and reset after a valid snapshot
✓ media-control stream subscription > nowplaying-cli remains polling-only and returns normalized state
✓ media-control stream subscription > two backends keep independent sampled and transport-mutated clocks
✓ media-control stream subscription > two live backends do not cross-contaminate pause and seek state
✓ media-control stream subscription > disposal cancels retries, stops the source once, and suppresses late events

 81 pass
 0 fail

All matched files use Prettier code style!
Verified npm package contents (12 files)

NX   Successfully ran targets typecheck, test, format:check, package:check for project music-core
```

## Residual risks

- Completeness requires media-control's full sample keys. If a provider ever streams a useful subset under a different stable shape, the gate will drop it until the shape list is widened deliberately.
- Host packages still need later phases to consume snapshot/invalidation events and backend-owned clocks.
- No commit was made (orchestrator owns verify gate + commit).
