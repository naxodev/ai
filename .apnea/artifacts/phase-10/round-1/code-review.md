---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 10 package is aligned with the approved plan. It isolates the Pi production cutover, keeps presentation local, adds the scoped mixed-host regression, and defers package cleanup, smokes, documentation, and OpenCode work. The product delta is limited to the three allowed paths.

## Findings

### High — Commands issued during live-session client acquisition are silently dropped

`session_start` assigns `session.acquisition` but returns without awaiting it (`packages/pi-music-dock/extensions/music-dock/index.ts:220-230`). The session is already current and live during that interval, while `command()` returns immediately whenever `session.client` is still undefined (`index.ts:157-160`). A user invoking `/music`, `/music-next`, `/music-prev`, or a shortcut while initial daemon acquisition/startup is pending therefore gets a successful no-op: no client method is called and no feedback is shown.

This is not the package's harmless “no live session” case; a live TUI session exists, and the acceptance contract requires each invocation to delegate exactly once. Await the caught acquisition from `session_start`, or have an invocation wait on that session's acquisition and then delegate once only if the same generation remains live. This must remain a narrow acquisition gate, not a transport queue or reconnect replay. Add a controllable-factory test proving a command made during acquisition is neither lost nor sent into a replacement generation and that its caller settles.

### Medium — Notification deduplication never resets after recovery

`notify()` suppresses any message equal to `session.lastNotification`, but ready/connected events never clear or advance that state (`index.ts:69-74`, `109-120`). Consequently, after `unavailable → ready → unavailable` or `reconnecting → connected → reconnecting`, a later incident with the same actionable message is hidden. A terminal event can also be suppressed when it shares the preceding reconnect message.

Deduplicate repeated observations within one unresolved incident, while resetting the relevant provider/connection notification ownership on recovery. Add recovery-cycle coverage for repeated provider degradation/unavailability and reconnect feedback.

### Medium — Required lifecycle acceptance evidence is incomplete

`packages/pi-music-dock/test/index.test.ts` covers unavailable provider feedback but never emits `degraded`, despite the package explicitly requiring both. It also does not exercise a terminal shutdown while client acquisition is pending; the existing pending-acquisition test only drives the synthetic reload path. Add the missing deterministic cases, including exact late client disposal and no late status/connection feedback after shutdown.

## Verification

The reported focused Pi suite, mixed-host real-socket test, full music-core/Pi Nx matrix, forbidden-source scans, and `git diff --check` all pass. The real-socket test demonstrates interleaved global FIFO ordering, independent Pi disposal/replacement, continued OpenCode replay/command operation, and one provider subscription. No forbidden direct provider, polling, sampling, reconciliation, playback-clock, or local transport-queue ownership remains in Pi production source.
