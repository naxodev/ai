---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 8 package remains aligned with the approved plan and production still selects the direct backend. Round 2 fixes several source issues within allowed paths, but lifecycle ownership and the required artwork/disposal/controller matrix remain incomplete.

## Findings

### High — Controller lifecycle clearing still destroys unrelated transport errors

The new `errorFromLifecycle` boolean prevents cached polls, snapshots, and successful commands from clearing an active lifecycle message. However, every lifecycle event still calls `setError(event.message)` (`packages/opencode-music-player/index.tsx:403-407`). If a command fails while reconnecting, the command error replaces the displayed lifecycle message; when connection B emits lifecycle `null`, `setError(null)` clears that command error and resets `errorFromTransport`, even though the package requires connected replacement to clear only connection-originated feedback.

Track error ownership/message separately (or clear only when the currently displayed error is the prior lifecycle-owned value). Add ordering tests for reconnect → command failure → connected, provider degradation plus command failure, and terminal transitions so one source cannot erase another incorrectly.

### High — Effective lifecycle replay is still duplicated and unavailable to late subscribers

`publishLifecycle()` emits unconditionally. During normal public-client replay, the status callback and connected callback both emit the same effective `null` (or degraded) lifecycle message; ready status during reconnect emits the same reconnect error again. Round 2 removed the extra post-install block but did not deduplicate these effective messages.

Conversely, a listener added after client installation receives no retained snapshot or lifecycle state unless acquisition failed. If `player()` wins acquisition before `subscribe()`, the public client's replay is emitted to an empty listener set and is lost to that subscriber. Retain/deduplicate the effective lifecycle projection and replay the latest projected snapshot plus lifecycle state once to each later backend subscriber. Isolate replay listener exceptions.

### High — Adapter-backed controller contract coverage remains far short of the package

The new controller case proves initial A state, retained reconnect feedback across one cached refresh, and lower-revision B projection. It uses an inline `any` client and does not exercise adapter-backed live playing/paused/idle projection, degraded/terminal feedback, loading and command failures/toasts, optimistic play/pause/seek, local seek coalescing, waveform fields, listener exception isolation, or late held-command suppression.

Use the deterministic public-contract fake through `createSessionSystemMedia` and prove the existing controller contract end to end. Existing controller tests against unrelated fake backends do not prove the adapter composition.

### High — Artwork and disposal acceptance remains largely absent

No artwork or lifecycle test file changed in Round 2. Session artwork still has only one immediate `available` case. Required unavailable/stale/too-large/rejected/disconnected/disposed outcomes, fallback arguments/retries, old-identity/generation completion suppression, and newer presentation ownership are untested.

Active-client exact-once unsubscribe/disposal, held callbacks after disposal, resolver/presentation suppression, repeated backend disposal completion, and controller suppression of late toast/timer/next-command work also remain absent. Extend the fake with held/failing commands and artwork plus exact subscription/disposal counters, then add the package-listed `controller-lifecycle` and `artwork-lifecycle` cases with deterministic cleanup.

## Resolved findings

Round 2 now combines provider and connection state with connection-error precedence, preserves degraded provider feedback after reconnect, centralizes acquisition failure observation, gives each default adapter a distinct stable process-local ID, and returns one shared disposal Promise. Cached controller polls no longer clear a currently lifecycle-owned error. A basic adapter-backed controller replay/replacement test is present.

## Verification

The four-file suite reports 56 passing tests and the Nx matrix reports 259 music-core plus 155 OpenCode tests with typecheck, format, and package checks green. `git diff --check` and selector inspection are clean. The exact preload form was not reported, but current verification is otherwise green; the blocking issue is missing/incorrect acceptance behavior above.
