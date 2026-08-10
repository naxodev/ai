---
status: done
---

# Suggested PR title

`refactor(music)!: adopt authoritative snapshots and transport queues`

# PR body

## TL;DR

App-originated pauses could wait for a fallback poll, and repeated controls could disappear behind a global busy latch. This four-phase stack projects complete stream snapshots immediately, queues accepted transport intents, and separates sampling, commands, artwork, and UI projection while retaining bounded 3/5/8-second recovery polling.

**Files to review (18, +2,855 / -761):**

| Files                                                                        | Why                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/music-core/system-media.ts`, `types.ts`, `clock.ts` _(start here)_ | Defines authoritative snapshot and terminal invalidation events, stream recovery, shared decoding, and backend-owned clocks.                          |
| `packages/opencode-music-player/system-media.ts`, `types.ts`                 | Separates playback projection from keyed artwork work and publishes matching artwork completion independently.                                        |
| `packages/opencode-music-player/index.tsx`                                   | Owns the OpenCode single-flight sample lane, ordered transport queue, stale-work guards, and disposal semantics.                                      |
| `packages/pi-music-dock/extensions/music-dock/index.ts`                      | Applies the same event, sampling, transport, polling, waveform, reload, and shutdown model in Pi.                                                     |
| `packages/**/tests/**`                                                       | Covers stream snapshots, termination, clock isolation, artwork completion, repeated controls, stale samples, and lifecycle cleanup deterministically. |
| `packages/*/README.md`                                                       | Documents direct snapshot projection, explicit clocks, bounded recovery polling, and lifecycle ownership.                                             |

## Why

The previous event path treated every `media-control stream` line as an invalidation. Hosts then called `player()`, so delayed sampling or artwork work could hide an authoritative pause or track change.

OpenCode and Pi also used busy state as an admission lock. Inputs received during provider or command work could return without representing the user's intent.

| Concern              | Before                            | After                                                                    |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| Complete stream data | Triggered another provider sample | Projects a normalized authoritative snapshot at arrival                  |
| Stream termination   | Recovered on later host work      | Emits one immediate invalidation and starts bounded restart recovery     |
| Repeated controls    | Could be dropped while busy       | Capture explicit intents and execute them in order                       |
| OpenCode seeks       | Rejected behind a seek latch      | Coalesce only adjacent pending seeks and settle every caller             |
| Artwork              | Delayed playback delivery         | Runs independently and decorates only the matching recording             |
| Playback clock       | Shared module-global state        | One clock per system-media backend                                       |
| Polling              | Shared with normal event delivery | Remains bounded recovery and the primary path for polling-only providers |

## What changed

### Phase 1 — authoritative core events and backend-owned clocks

- Normalizes explicit `player()` results and complete stream payloads through one media decoder and one arrival timestamp.
- Emits discriminated `snapshot` and `invalidation` events. A stream generation emits one terminal invalidation, then restarts with capped 1/2/4/8-second backoff that resets after valid data.
- Replaces the hidden clock singleton with `createPlaybackClock()`. Sampling and successful transport mutations stay isolated per backend.
- Keeps `nowplaying-cli` polling-only and makes stream disposal idempotent and generation-safe.

### Phase 2 — independent artwork presentation

- Returns playback state without awaiting native artwork sampling, lookup, download, conversion, or retries.
- Deduplicates unresolved work by complete recording identity, independent of volatile provider IDs, while retaining the 32-entry settled cache and bounded retries.
- Publishes artwork completion through a separate OpenCode presentation subscription. Controllers merge only artwork and missing duration into the matching live track.
- Preserves artwork selection, download limits, conversion, the Kitty-facing shape, and rendering behavior.

### Phase 3 — OpenCode sampling and transport lanes

- Replaces global busy and seek latches with a single-flight sampling lane and a serialized intent queue.
- Captures repeated toggles as explicit play or pause targets, preserves skip order, and coalesces only adjacent not-yet-started seeks.
- Uses request sequence, transport revision, and lifecycle generation checks to reject stale asynchronous samples. New authoritative snapshots always project immediately.
- Resolves handled command failures and canceled callers without unhandled rejections. Disposal suppresses queued and late command, sample, artwork, timer, toast, and app-open effects.

### Phase 4 — Pi event and transport adoption

- Projects authoritative snapshots directly into Pi status and waveform state, while invalidation enters the same coalesced sample lane.
- Queues repeated toggle, next, and previous intents independently from provider refresh and preserves existing reconciliation delays outside the command lane.
- Gives each TUI session ownership of its subscription, poll, waveform, sample generation, transport queue, and lifecycle token.
- Fully detaches old-session effects on reload and shutdown while preserving commands, shortcuts, status text, notifications, and polling-only operation.

## Reviewer notes

- **Core clock API changes intentionally.** `createPlaybackClock()` replaces the exported stateful singleton helpers. The package README documents the explicit instance API; this is why the suggested title carries `!`.
- **Subscription events remain additive.** `MusicBackend.subscribe` stays optional, and existing no-argument listeners remain type-compatible because the event argument is optional.
- **Authoritative means immediate.** Snapshot callbacks bypass sample arbitration and presentation merges. Sequence guards prevent older provider reads from restoring stale state.
- **Transport stays serialized.** Commands do not overlap against one backend, but provider sampling, reconciliation delays, artwork work, and synchronous projection cannot hold the command lane.
- **Polling stays bounded.** Both hosts retain one state-based 3/5/8-second timeout for recovery and for backends without subscriptions.
- **PR #40 remains unchanged.** This stack contains four commits on top of `fix/music-player-sync` and should target that branch for isolated review.

## Tests

All final phase reviews approved the implementation with no findings.

| Command                                                                                                           | Result                                                                     |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `bunx nx run-many -t typecheck test format:check package:check --projects=music-core`                             | Pass; 82 tests, package contents verified                                  |
| `bunx nx run-many -t typecheck test format:check package:check smoke --projects=opencode-music-player`            | Pass; 146 tests, package contents verified, installed-package smoke passed |
| `bunx nx run-many -t typecheck test format:check package:check smoke --projects=pi-music-dock`                    | Pass; 28 tests, package dry-run and Pi command-registration smoke passed   |
| `bunx nx run-many -t typecheck test format:check package:check -p music-core opencode-music-player pi-music-dock` | Pass across all three packages                                             |
| `bunx nx run-many -t smoke -p opencode-music-player pi-music-dock`                                                | Pass; both packed consumers loaded successfully                            |
| `bun run check`                                                                                                   | Final commit-gate log exits 0                                              |
| `git diff --check`                                                                                                | Pass                                                                       |

Deterministic regressions cover app-originated pause before a held sample settles, immediate recovery after stream termination, repeated controls during delayed refresh, adjacent seek coalescing, stale-sample rejection, artwork completion without resampling, command failures, disposal, Pi reload, and shutdown.

## Residual risk

- The OpenCode installed-package smoke passed, but Nx marked it flaky after one unrelated transient sidebar-toggle failure on an earlier run.
- The settled artwork cache remains bounded to 32 entries. Unresolved jobs stay in a separate map until their promises settle so eviction cannot start duplicate work; many permanently unresolved identities could retain memory.
- Verification exercises provider streams, timers, and host lifecycles through deterministic fakes plus packed-package consumers. It does not include a live macOS `media-control` session or an interactive terminal exercise.

## Links

- [PR #40](https://github.com/naxodev/ai/pull/40)
