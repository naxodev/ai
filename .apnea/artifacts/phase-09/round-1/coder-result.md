---
status: done
---

## Changed

- Switched the default OpenCode controller backend to `createSessionSystemMedia` and removed local provider executable probing.
- Removed the direct OpenCode media facade, native command/sample path, polling/reconciliation lane, playback clock ownership, and general transport queue.
- Kept direct UI commands immediate with per-operation loading/error handling and a bounded latest-seek lane; daemon snapshots remain authoritative.
- Retained daemon-backed native artwork with bounded host-local cache/job/presentation behavior and disposal fencing.
- Reworked controller, adapter, lifecycle, and package-load tests around deterministic session clients and production cutover behavior.

Files touched:

- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/tests/controller.test.ts`
- `packages/opencode-music-player/tests/controller-lifecycle.test.ts`
- `packages/opencode-music-player/tests/system-media.test.ts`
- `packages/opencode-music-player/tests/package-load.test.ts`

## Verification

```text
$ (cd packages/opencode-music-player && bun test --preload @opentui/solid/preload tests/system-media.test.ts tests/controller.test.ts tests/controller-lifecycle.test.ts tests/artwork-lifecycle.test.ts tests/package-load.test.ts)
exit 0
19 pass
0 fail
87 expect() calls

$ bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player
exit 0
NX Successfully ran targets typecheck, test, format:check, package:check for 2 projects
music-core: 259 pass, 0 fail
opencode-music-player: 116 pass, 0 fail

$ ! rg -n 'createSystemMedia|hasMediaControl|hasNowPlayingCli|POLL_PLAYING_MS|pendingSample|transportRevision' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
exit 0

$ ! rg -n 'media-control.*get.*--now|media-control.*stream|nowplaying-cli|createPlaybackClock' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
exit 0

$ jj diff --summary && git diff --check
exit 0
Inspected the exact allowed OpenCode phase diff (six source/test paths); git diff --check is clean.
```

## Residual risks

- Production now relies on the existing reconnecting session daemon; no packed/live host smoke was run, per Phase 9 scope.
- Existing dirty `.apnea/state.json` and task/package artifacts were not modified.
