---
status: done
---

## What changed

Fixed reentrant subscription disposal during a stream-termination invalidation. Terminal handling now rechecks that its generation remains current after calling the listener, before it schedules a retry timer.

Added a regression where the invalidation listener calls its subscription disposer. It verifies that no retry timer remains active and the stream source is released once.

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
✓ media-control stream subscription > terminal error/exit/close emit one immediate invalidation and one restart
✓ media-control stream subscription > disposal from an invalidation listener does not leave a retry timer
✓ media-control stream subscription > retry delays cap at 1/2/4/8 seconds and reset after a valid snapshot
✓ media-control stream subscription > nowplaying-cli remains polling-only and returns normalized state
✓ media-control stream subscription > two backends keep independent sampled and transport-mutated clocks
✓ media-control stream subscription > two live backends do not cross-contaminate pause and seek state
✓ media-control stream subscription > disposal cancels retries, stops the source once, and suppresses late events

82 pass
0 fail
All matched files use Prettier code style!
Verified npm package contents (12 files)

NX   Successfully ran targets typecheck, test, format:check, package:check for project music-core
```

## Residual risks

The listener remains synchronous by contract. An asynchronous disposer invoked after the listener returns can leave the intended retry timer active until that disposer runs.
