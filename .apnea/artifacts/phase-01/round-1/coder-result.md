---
status: done
---

# Phase 1 coder result

## What changed

Replaced the module-global playback clock with an explicit `createPlaybackClock()` factory. Each `createSystemMedia()` backend owns one clock instance and routes sampling, idle, play, pause, seek, next, and previous through it.

Extended `MusicBackend.subscribe` additively with discriminated `MusicChangeEvent` values:

- `type: "snapshot"` carries a complete normalized `PlayerState`
- `type: "invalidation"` with `reason: "stream-terminated"` on first terminal of a stream generation

`media-control` stream lines now decode complete payloads through the same decoder as `player()` get, emit authoritative snapshots immediately without calling `player()`, ignore malformed/non-data/incomplete envelopes, reset retry backoff only after a valid snapshot, and emit one terminal invalidation per generation before the capped 1/2/4/8s restart.

`nowplaying-cli` remains polling-only. Subscription disposal is idempotent and suppresses late callbacks.

## Files touched

- `packages/music-core/clock.ts`
- `packages/music-core/system-media.ts`
- `packages/music-core/types.ts`
- `packages/music-core/index.ts`
- `packages/music-core/tests/clock.test.ts`
- `packages/music-core/tests/system-media.test.ts`
- `packages/music-core/README.md`

## Verify transcript

Command:

```sh
bunx nx run-many -t typecheck test format:check package:check --projects=music-core
```

Exit code: `0`

Tail:

```
tests/system-media.test.ts:
✓ media-control stream subscription > emits an authoritative paused snapshot without calling player()
✓ media-control stream subscription > player() and stream snapshots share normalization and arrival timestamps
✓ media-control stream subscription > ignores malformed, non-data, and incomplete envelopes then accepts a valid one
✓ media-control stream subscription > terminal error/exit/close emit one immediate invalidation and one restart
✓ media-control stream subscription > retry delays cap at 1/2/4/8 seconds and reset after a valid snapshot
✓ media-control stream subscription > nowplaying-cli remains polling-only and returns normalized state
✓ media-control stream subscription > two backends keep independent sampled and transport-mutated clocks
✓ media-control stream subscription > two live backends do not cross-contaminate pause and seek state
✓ media-control stream subscription > disposal cancels retries, stops the source once, and suppresses late events

 80 pass
 0 fail

All matched files use Prettier code style!
Verified npm package contents (12 files)

NX   Successfully ran targets typecheck, test, format:check, package:check for project music-core
```

## Residual risks

- Host packages still import removed module-global clock helpers (`syncFromSample`, `resetClock`, `setClockPlaying`, `seekClock`). Phase 1 intentionally changes only `music-core`; later host phases must adopt `createPlaybackClock` / backend-owned clocks and the new subscribe events.
- Stream completeness uses identity fields or an explicit `playing` boolean. Elapsed-only envelopes are treated as incomplete and do not emit. If a real provider emits useful partials under another shape, the filter may need widening.
- No commit was made (orchestrator owns verify gate + commit).
