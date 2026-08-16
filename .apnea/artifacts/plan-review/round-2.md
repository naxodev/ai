---
status: done
verdict: CHANGES_REQUIRED
---

## Findings

### High — Phase 2 still lacks a self-contained verification gate

The prior blocker remains unresolved. Phase 2 presents mutually exclusive assertions as one flat command list: it first requires a live daemon and socket, then immediately requires both to be absent. The commands do not launch the two pinned hosts, load the checkout integrations, perform or record the control/reload/exit flow, transition from the live state to the closed state, wait through idle cleanup, or validate the recorded evidence afterward. Consequently, `apnea commit` cannot execute this verification coherently from a fresh shell.

Revise the phase into explicit, executable stages (prerequisites, live-session capture, and post-close cleanup), or produce a durable phase-local evidence artifact plus a self-contained command that validates it after the interactive session. Evidence must be tied to the exact host versions and checkout paths and cover daemon PID/generation, owner-only socket metadata, provider ownership, Pi reload, client exits, and final idle cleanup.
