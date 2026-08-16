---
status: done
---

## Changed

- Replaced each deferred key's first-waiter closure with per-host invocation contexts (native callback, resolver, target, identity, and clock).
- Deferred admission now selects a live waiter's own context, so disposing the first waiter cannot issue native artwork work through its disposed client or resolver for a surviving waiter.
- Kept equal-key deferred completion sharing by attaching every live deferred interest to the selected job.
- Defined the bounded overflow outcome explicitly: a deferred-key or per-key-interest overflow returns settled `artwork: null` / `artwork_loading: false`, avoiding a permanent loading presentation in the no-poll model.
- Added coverage for first-waiter disposal before admission and overflow's stable no-artwork presentation.

Files touched:

- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/tests/system-media.test.ts`

## Verification

```text
$ (cd packages/opencode-music-player && bun run check && bun test --preload @opentui/solid/preload tests/system-media.test.ts tests/controller.test.ts tests/controller-lifecycle.test.ts tests/artwork-lifecycle.test.ts tests/package-load.test.ts)
exit 0
31 pass
0 fail
130 expect() calls

$ bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player
exit 0
NX Successfully ran targets typecheck, test, format:check, package:check for 2 projects
music-core: 259 pass, 0 fail
opencode-music-player: 128 pass, 0 fail

$ ! rg -n 'createSystemMedia|hasMediaControl|hasNowPlayingCli|POLL_PLAYING_MS|pendingSample|transportRevision' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
exit 0

$ ! rg -n 'media-control.*get.*--now|media-control.*stream|nowplaying-cli|createPlaybackClock' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
exit 0

$ git diff --check && jj diff --summary
exit 0
Diff check is clean. Existing .apnea state/task/artifact dirt was inspected and left untouched.
```

## Residual risks

- Packed/live host smoke remains intentionally deferred to its later phase.
- Existing dirty `.apnea/state.json` was not edited.
