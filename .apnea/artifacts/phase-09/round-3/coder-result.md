---
status: done
---

## Changed

- Replaced host-local deferred-artwork callbacks with bounded, key-based deferred interests. Equal-key waiters now share one admitted native/resolver job and receive correlated completion events.
- Centralized artwork-slot release so both normal settlement and owner disposal admit the next deferred identity. Disposed hosts are removed from deferred interests.
- Bounded deferred keys and per-key retained interests to 32, while preserving deterministic FIFO settled-cache eviction.
- Retained lifecycle and transport feedback independently in the controller. Connection feedback remains authoritative; transport failure temporarily overrides provider feedback; transport success restores the retained degraded/unavailable provider message without requiring another daemon event.
- Added coverage for disposal-based admission, shared deferred completion, settled-cache eviction, overlapping command loading, canceled unissued latest seeks on reconnect, and both lifecycle/transport ordering cases.

Files touched:

- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/types.ts`
- `packages/opencode-music-player/tests/controller.test.ts`
- `packages/opencode-music-player/tests/controller-lifecycle.test.ts`
- `packages/opencode-music-player/tests/system-media.test.ts`
- `packages/opencode-music-player/tests/package-load.test.ts`

## Verification

```text
$ bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player
exit 0
NX Successfully ran targets typecheck, test, format:check, package:check for 2 projects
music-core: 259 pass, 0 fail
opencode-music-player: 126 pass, 0 fail

$ (cd packages/opencode-music-player && bun test --preload @opentui/solid/preload tests/system-media.test.ts tests/controller.test.ts tests/controller-lifecycle.test.ts tests/artwork-lifecycle.test.ts tests/package-load.test.ts)
exit 0
29 pass
0 fail
124 expect() calls

$ ! rg -n 'createSystemMedia|hasMediaControl|hasNowPlayingCli|POLL_PLAYING_MS|pendingSample|transportRevision' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
exit 0

$ ! rg -n 'media-control.*get.*--now|media-control.*stream|nowplaying-cli|createPlaybackClock' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
exit 0

$ git diff --check && jj diff --summary
exit 0
Diff check is clean. Only allowed OpenCode implementation/test paths changed; existing .apnea state/task/artifact dirt was inspected and left untouched.
```

## Residual risks

- Packed/live host smoke remains intentionally deferred to its later phase.
- Existing dirty `.apnea/state.json` was not edited.
