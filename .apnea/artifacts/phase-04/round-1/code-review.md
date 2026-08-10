---
status: done
verdict: CHANGES_REQUIRED
---

# Findings

## Medium

1. `packages/pi-music-dock/extensions/music-dock/index.ts:305` clears the shutdown UI before marking the live session inactive and detaching `currentSession`. This violates the package requirement to mark a session inactive before releasing any owned resource. A synchronous external UI callback can still re-enter live session work during disposal. Deactivate and detach the session before calling `ctx.ui.setStatus`, while retaining the required shutdown clear through the event context.

2. `packages/pi-music-dock/test/index.test.ts:232-344` does not provide the required deterministic reload and shutdown coverage. The tests do not hold an active command with additional queued callers, prove immediate settlement during disposal, prove queued backend methods never start, or exercise late command success/rejection, subscription events, reconciliation delays, timeout callbacks, and waveform interval callbacks against a replacement or shutdown session. The current reload command test settles the old backend rejection before awaiting its caller, so it cannot prove immediate caller settlement. Add the package-required lifecycle regression before accepting late-effect suppression and waveform ownership.

3. `packages/pi-music-dock/test/index.test.ts:49-112` discards shortcut handlers and makes every reconciliation delay resolve immediately. This leaves two explicit package contracts unproved: shortcut caller behavior, and release of the command lane before the 120/150 ms delay or reconciliation sample settles. Capture shortcut handlers and use controllable delay promises so the next FIFO backend command is observed before detached reconciliation completes.

## Review Notes

The phase package remains within the approved Phase 4 plan and the changed product files match its declared scope. Package checks, smoke checks, and targeted tests have reported passing evidence. The root formatting failure is the documented pre-existing Apnea Markdown baseline constraint and is not product evidence for this verdict.
