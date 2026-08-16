---
status: done
---

# Phase 10 package — migrate Pi and prove mixed-host command behavior

## Intent

Replace Pi music-dock's direct `MusicBackend` ownership, executable probes, sampling/polling, reconciliation delays, and local transport queue with one reconnecting music-session client per live TUI session. Keep Pi's status-line and waveform presentation local, preserve `/music`, `/music-next`, `/music-prev`, and the three shortcuts, and prove that Pi and OpenCode identities use the daemon's shared global FIFO without owning each other's lifetime.

This phase is only the Pi cutover. Do not repair the committed OpenCode implementation, perform package-surface cleanup, add packed smokes, update documentation, or run the final release gate here.

## Implementation steps

1. **Replace the Pi dependency seam with the public session-client contract.**
   - In `packages/pi-music-dock/extensions/music-dock/index.ts`, import `createReconnectingMusicSessionClient` and only the public session types needed from `@naxodev/music-core`.
   - Define an injectable client-factory seam around `ReconnectingMusicSessionClient`/`ReconnectingMusicSessionClientOptions`; tests must be able to return a deterministic fake and inspect the requested options.
   - The production factory must create a unique Pi client ID, set `hostKind: "pi"`, and negotiate only the state replay and transport capabilities Pi uses. Use the repository-pinned core Promise adapter; do not introduce another socket/runtime implementation or another Effect runtime in the extension.
   - Keep only dependencies needed for Pi-local presentation, such as `Date.now`, `setInterval`, and `clearInterval` for `createWaveformCoordinator`.
   - Remove `MusicBackend`, `createSystemMedia`, executable/provider probes, poll timers, sleep/reconciliation hooks, sample state, optimistic transport revision state, and local command-intent queues.

2. **Make one live-session record own one client and local presentation.**
   - Create the client from `session_start`, never from the extension factory. A non-TUI/no-UI start must not create a client or timer.
   - Track a per-start generation/active flag, the client acquisition, installed client, subscription disposers, current authoritative `PlayerState`, UI reference, and waveform coordinator. Do not retain provider, socket, daemon, or transport-worker internals.
   - Subscribe once each to client state, provider status, and connection lifecycle. Project `RevisionedState.state` directly as authoritative state; do not merge it with a sampled or optimistic copy.
   - Replay and live snapshots must render the existing play/pause icon, clipped track/artist text, and waveform. Paused snapshots must settle the waveform locally; idle snapshots must clear status and stop the waveform. A replacement daemon's revision reset is accepted through the reconnecting client's already-fenced public stream.
   - Preserve the last rendered state while reconnecting. Surface deduplicated, actionable provider degradation/unavailability and connection reconnect/terminal messages through Pi notifications without logging playback payloads. Initial acquisition/incompatibility failures must become user feedback rather than an unhandled `session_start` rejection.

3. **Route commands directly through the daemon client.**
   - `/music` and its shortcut call `client.toggle()` exactly once; `/music-next` and its shortcut call `client.next()` exactly once; `/music-prev` and its shortcut call `client.previous()` exactly once.
   - Do not infer play versus pause locally, optimistically mutate the status, delay a reconciliation sample, serialize commands in Pi, or replay a command after reconnect. The daemon/client contract owns global FIFO and indeterminate-command behavior.
   - Keep each invocation's `ExtensionContext` for feedback. A rejected command while the same Pi session is live must notify that caller once with the actionable error and settle the handler. Calls made with no live session remain harmless. A command completion from a dead/reloaded generation must not notify or mutate the new session.

4. **Make reload and shutdown terminal for the old Pi generation.**
   - Follow Pi's documented lifecycle: `session_shutdown` cleans session-scoped resources before a replacement `session_start`; repeated cleanup is idempotent.
   - Mark the old session inactive and detach it from `currentSession` before unsubscribing, clearing status, stopping the waveform, or awaiting client disposal.
   - Dispose exactly that Pi client once. If shutdown/reload wins while client acquisition is pending, dispose the client immediately if it later resolves. Await the resulting disposal from `session_shutdown` without blocking on unrelated clients.
   - Fence all late state/status/connection callbacks, acquisition outcomes, and command completions by the old session identity. Starting a replacement session must not allow the old generation to clear or repaint the replacement UI.

5. **Rewrite Pi controller tests around a deterministic reconnecting-client fake.**
   - In `packages/pi-music-dock/test/index.test.ts`, replace `MusicBackend`, probe, poll, sleep, and local transport-queue fixtures with a fake implementing only the exported `ReconnectingMusicSessionClient` contract plus explicit state/status/connection emitters and controllable command/acquisition/disposal gates.
   - Prove no client is created before a live TUI `session_start`, one factory call supplies `hostKind: "pi"` and the intended capabilities, and one session installs one set of subscriptions.
   - Cover replay plus live playing/paused/idle state, a replacement generation with a reset revision, retained presentation during reconnect, provider unavailable/degraded feedback, and terminal incompatibility feedback.
   - Cover exact command mapping for all commands and shortcuts, concurrent calls reaching the fake immediately rather than a Pi queue, and one notification per rejected live call.
   - Cover reload and shutdown during pending acquisition, pending commands, and active waveform work. Assert old callbacks/completions are inert, old disposal occurs once, status/timers are cleared, and the replacement client remains active.

6. **Add one real mixed-host daemon regression without widening core behavior.**
   - In `packages/music-core/tests/session-server.test.ts`, add a focused real-socket test with one `hostKind: "opencode"` client and one `hostKind: "pi"` client against one selected server/provider graph.
   - Hold the first provider transport operation, submit interleaved Pi/OpenCode commands, release it, and assert provider observation follows one global FIFO and each command settles once.
   - Dispose the old Pi client, connect a replacement Pi identity to model reload, and prove the OpenCode client still receives a later state snapshot and can issue another command. Assert one provider/subscription/coordinator remains in use until the final clients/server are closed.
   - Prefer a test-only addition. Do not change core production code or `packages/music-core/tests/session-client.test.ts` unless this exact public-contract scenario exposes a core defect; if it does, keep the fix minimal and add the narrow regression there.

7. **Keep package metadata stable in this phase.**
   - `@naxodev/music-core` is already a runtime dependency and Pi's extension directory is already packaged. Do not change manifests, the lockfile, package scripts, or smoke scripts merely for this cutover.

## Files to touch

Required:

- `packages/pi-music-dock/extensions/music-dock/index.ts`
- `packages/pi-music-dock/test/index.test.ts`
- `packages/music-core/tests/session-server.test.ts`

Conditional only if the focused mixed-host regression exposes a defect in the existing reconnecting-client contract:

- `packages/music-core/session/client.ts`
- `packages/music-core/tests/session-client.test.ts`

## Files not to touch

- `packages/opencode-music-player/**` — preserve the committed Phase 9 cutover; its prior review findings are not Phase 10 scope.
- Other `packages/music-core/session/**` production files, especially provider, coordinator, protocol, server, and daemon ownership, unless the exact conditional client defect above is demonstrated.
- `packages/pi-music-dock/extensions/music-dock/format.ts`
- `packages/pi-music-dock/extensions/music-dock/waveform.ts`
- `packages/pi-music-dock/package.json`
- `packages/pi-music-dock/project.json`
- `packages/pi-music-dock/scripts/**`
- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `package.json`
- `bun.lock`
- Any README or `docs/**`, including `docs/music-session-architecture.html`.
- Packed-smoke files, generated artifacts, runtime socket/marker/reservation files, unrelated dirty changes, and `.apnea/state.json`.

## Acceptance checks

- A live TUI Pi extension owns exactly one reconnecting client and only Pi-local state/status rendering plus waveform work. Extension load and non-TUI starts own no client, daemon, provider, or timer.
- Production client options identify `hostKind: "pi"`, use a unique client ID, and request state replay/transport without adding Pi artwork or seek behavior.
- Pi contains no direct provider object, executable availability probe/retry, native media command, event-stream owner, sampling lane, polling timer, playback clock, reconciliation delay, optimistic state, or general transport queue.
- Replay and live playing/paused/idle snapshots render correctly. Replacement-generation snapshots remain authoritative, reconnect retains the last presentation, and provider/connection/incompatibility failures produce actionable bounded feedback.
- `/music`, `/music-next`, `/music-prev`, and the corresponding shortcuts each delegate once to `toggle`, `next`, or `previous`. Rejected calls notify their own context once; no command is locally replayed or queued across generations.
- Reload/shutdown marks the old session dead before cleanup, unsubscribes, clears its status, stops its waveform timer, disposes its client exactly once (including pending acquisition), and suppresses all late old-generation effects.
- A real Pi and OpenCode client share one selected daemon/provider and one global FIFO. Disposing/replacing Pi neither closes nor starves OpenCode; OpenCode still receives state and commands successfully.
- Existing core singleton/startup, reconnect, idle, bounded fan-out, artwork, and OpenCode behavior remain regression baselines only.

## Verification commands

Run from the repository root:

```sh
bun test packages/pi-music-dock/test/index.test.ts -t 'session client|replay|replacement|reconnect|incompatib|command|reload|shutdown'
bun test packages/music-core/tests/session-server.test.ts -t 'mixed-host|Pi.*OpenCode|OpenCode.*Pi'
bun test packages/pi-music-dock/test/index.test.ts packages/pi-music-dock/test/format.test.ts packages/pi-music-dock/test/waveform.test.ts
bunx nx run-many -t typecheck test format:check package:check --projects=music-core,pi-music-dock
! rg -n 'createSystemMedia|hasMediaControl|hasNowPlayingCli|POLL_PLAYING_MS|POLL_PAUSED_MS|POLL_IDLE_MS|schedulePoll|requestSample|pendingSample|sampleRequestSequence|transportRevision|pendingIntents|activeIntent|createPlaybackClock|mergePlayer' packages/pi-music-dock/extensions/music-dock/index.ts
! rg -n 'startLineStream|whichOk|setTimeout\(|clearTimeout\(|Bun\.sleep|sleep\(' packages/pi-music-dock/extensions/music-dock/index.ts
git diff --check
jj diff --summary
```

The Nx suites are broad regression gates; they do not authorize Phase 11 cleanup or Phase 12–14 packed-smoke work.

## Dependencies

- Phase 6's bounded real-socket fan-out and daemon-owned global FIFO.
- Phase 4's reconnecting public client, generation fencing, retained state, terminal incompatibility, and no command replay.
- Phase 5's independent client disposal/idle semantics.
- Phase 9's committed OpenCode session cutover at `a40bda4e`; do not fold unresolved OpenCode review work into this phase.
- Pi's documented project/global extension loading and `session_start`/idempotent `session_shutdown` lifecycle.
- Repository-pinned Effect TypeScript `4.0.0-beta.101` through `@naxodev/music-core`; no alternate Effect version.

## Non-goals

- Fixing or redesigning OpenCode, including prior Phase 9 snapshot/artwork review findings.
- Pi artwork, catalog lookup, image rendering, seek, footer ownership, command/shortcut renaming, or status-line redesign.
- New protocol capabilities, provider/coordinator/server ownership changes, singleton/startup changes, reconnect policy changes, idle policy changes, or fan-out tuning.
- Package export/manifest/lockfile cleanup, packed core/OpenCode/Pi smokes, exact-pinned live-host certification, documentation, full-workspace release verification, publishing, or PR work.
- Committing, squashing, pushing, or editing `.apnea/state.json`; the orchestrator performs the reviewed-child `jj squash` only after approval.
