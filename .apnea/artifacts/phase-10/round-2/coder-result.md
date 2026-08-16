---
status: done
---

## Changed

- Added a narrow per-generation acquisition gate for Pi commands: a command issued while its live session is acquiring waits for that session's client, delegates exactly once, and becomes inert if reload/shutdown wins. It is not a transport queue and never crosses into a replacement session.
- Split provider, reconnecting, terminal, and acquisition notification ownership. Ready/connected recovery resets the relevant incident key, while a terminal message is distinct from a preceding reconnect message.
- Expanded Pi coverage for acquisition-time commands, replacement fencing, degraded/unavailable recovery cycles, terminal feedback, and shutdown during pending client acquisition with late callback suppression.

Files touched:

- `packages/pi-music-dock/extensions/music-dock/index.ts`
- `packages/pi-music-dock/test/index.test.ts`

## Verification

```text
$ bun test packages/pi-music-dock/test/index.test.ts -t 'session client|replay|replacement|reconnect|incompatib|command|reload|shutdown'
exit 0
9 pass
1 filtered out

$ bun test packages/music-core/tests/session-server.test.ts -t 'mixed-host|Pi.*OpenCode|OpenCode.*Pi'
exit 0
1 pass
0 fail

$ bun test packages/pi-music-dock/test/index.test.ts packages/pi-music-dock/test/format.test.ts packages/pi-music-dock/test/waveform.test.ts
exit 0
23 pass
0 fail

$ bunx nx run-many -t typecheck test format:check package:check --projects=music-core,pi-music-dock
exit 0
NX Successfully ran targets typecheck, test, format:check, package:check for 2 projects
music-core: 260 pass, 0 fail
pi-music-dock: 23 pass, 0 fail

$ ! rg -n 'createSystemMedia|hasMediaControl|hasNowPlayingCli|POLL_PLAYING_MS|POLL_PAUSED_MS|POLL_IDLE_MS|schedulePoll|requestSample|pendingSample|sampleRequestSequence|transportRevision|pendingIntents|activeIntent|createPlaybackClock|mergePlayer' packages/pi-music-dock/extensions/music-dock/index.ts
exit 0

$ ! rg -n 'startLineStream|whichOk|setTimeout\(|clearTimeout\(|Bun\.sleep|sleep\(' packages/pi-music-dock/extensions/music-dock/index.ts
exit 0

$ git diff --check && jj diff --summary
exit 0
Diff check is clean. Existing .apnea state/task/artifact dirt was left untouched.
```

## Residual risks

- Packed/live host smoke and package-surface cleanup remain deferred to later phases.
- Existing dirty `.apnea/state.json` was not edited.
