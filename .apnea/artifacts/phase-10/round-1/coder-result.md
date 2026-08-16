---
status: done
---

## Changed

- Replaced Pi's direct media backend, provider probes, polling/sampling, reconciliation, optimistic state, and local transport queue with one reconnecting session client per live TUI session.
- Added an injectable public client-factory seam. Production identifies Pi with a unique client ID, `hostKind: "pi"`, and only `state-replay`/`transport` capabilities.
- Projected replay/live daemon state directly into Pi-local status and waveform presentation; provider and connection failures now produce deduplicated actionable notifications.
- Routed `/music`, `/music-next`, `/music-prev`, and all three shortcuts directly to `toggle`, `next`, and `previous` without local serialization or replay.
- Made pending acquisition, command completion, state, status, and connection callbacks generation-fenced across reload/shutdown; cleanup unsubscribes, clears waveform/status, and disposes only the Pi client once.
- Added a real socket mixed-host regression proving Pi/OpenCode global FIFO ordering, Pi replacement, and continued OpenCode state/command operation on one provider graph.

Files touched:

- `packages/pi-music-dock/extensions/music-dock/index.ts`
- `packages/pi-music-dock/test/index.test.ts`
- `packages/music-core/tests/session-server.test.ts`

## Verification

```text
$ bun test packages/pi-music-dock/test/index.test.ts -t 'session client|replay|replacement|reconnect|incompatib|command|reload|shutdown'
exit 0
7 pass
1 filtered out

$ bun test packages/music-core/tests/session-server.test.ts -t 'mixed-host|Pi.*OpenCode|OpenCode.*Pi'
exit 0
1 pass
0 fail

$ bun test packages/pi-music-dock/test/index.test.ts packages/pi-music-dock/test/format.test.ts packages/pi-music-dock/test/waveform.test.ts
exit 0
21 pass
0 fail

$ bunx nx run-many -t typecheck test format:check package:check --projects=music-core,pi-music-dock
exit 0
NX Successfully ran targets typecheck, test, format:check, package:check for 2 projects
music-core: 260 pass, 0 fail
pi-music-dock: 21 pass, 0 fail

$ ! rg -n 'createSystemMedia|hasMediaControl|hasNowPlayingCli|POLL_PLAYING_MS|POLL_PAUSED_MS|POLL_IDLE_MS|schedulePoll|requestSample|pendingSample|sampleRequestSequence|transportRevision|pendingIntents|activeIntent|createPlaybackClock|mergePlayer' packages/pi-music-dock/extensions/music-dock/index.ts
exit 0

$ ! rg -n 'startLineStream|whichOk|setTimeout\(|clearTimeout\(|Bun\.sleep|sleep\(' packages/pi-music-dock/extensions/music-dock/index.ts
exit 0

$ git diff --check && jj diff --summary
exit 0
Diff check is clean. Only Phase 10 allowed paths changed; existing .apnea state/package task dirt was left untouched.
```

## Residual risks

- Packed/live host smoke and package-surface cleanup remain deferred to later phases.
- Existing dirty `.apnea/state.json` was not edited.
