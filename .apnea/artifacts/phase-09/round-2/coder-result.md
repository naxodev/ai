---
status: done
---

## Changed

- Added a narrow daemon-snapshot epoch fence so late command success cannot overwrite newer authoritative play/pause/seek state.
- Kept connection and provider lifecycle origins distinct so provider recovery feedback cannot erase a later transport failure, while reconnect/terminal feedback remains actionable.
- Reinstated deterministic artwork coverage for equal-key sharing, bounded null/rejected fallback, 32-job admission, deferred-current recovery, and late A/B completion fencing.
- Added one-per-live-adapter deferred artwork admission: a full job set retains only the current identity and deterministically admits it when a slot settles; disposal removes that wait.
- Updated package-load proof to use `createSessionSystemMedia` with a deterministic reconnecting client and verify one client, daemon status feedback, and exact-once release.
- Extended controller/lifecycle coverage for snapshot-versus-command races, presentation completion, reconnect commands, and held artwork/reconnect disposal.

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
$ (cd packages/opencode-music-player && bun run check && bun test --preload @opentui/solid/preload tests/system-media.test.ts tests/controller.test.ts tests/controller-lifecycle.test.ts tests/artwork-lifecycle.test.ts tests/package-load.test.ts)
exit 0
24 pass
0 fail
105 expect() calls

$ bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player
exit 0
NX Successfully ran targets typecheck, test, format:check, package:check for 2 projects
music-core: 259 pass, 0 fail
opencode-music-player: 121 pass, 0 fail

$ ! rg -n 'createSystemMedia|hasMediaControl|hasNowPlayingCli|POLL_PLAYING_MS|pendingSample|transportRevision' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
exit 0

$ ! rg -n 'media-control.*get.*--now|media-control.*stream|nowplaying-cli|createPlaybackClock' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
exit 0

$ git diff --check && jj diff --summary
exit 0
Diff check is clean; inspected allowed OpenCode phase paths. Existing .apnea state/task/artifact dirt remains untouched.
```

## Residual risks

- Packed/live host smoke remains intentionally deferred to the later smoke phase.
- Existing dirty `.apnea/state.json` was not edited.
