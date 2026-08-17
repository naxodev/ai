---
status: done
verdict: CHANGES_REQUIRED
---

# Findings

The Phase 2 package is consistent with approved Plan Phase 2, so review proceeds against the package. No product implementation diff is present.

## High — The required mixed-host certification did not occur

The exact isolated OpenCode UI rendered `1 plugin failed`. The coder correctly treated that as a blocker, but consequently Pi was never launched and there is no evidence for simultaneous shared state, controls in both directions, Pi `/reload` generation preservation, Pi-exit isolation, post-Pi OpenCode control, or restoration of the original playback state. These are mandatory Phase 2 acceptance checks, so the phase cannot be approved.

The result does provide credible fail-closed evidence: the exact isolated OpenCode version/path and failed UI are recorded; final history/scope checks pass; and the protected PID, command, generation, socket tuple, ownership, and baseline `lsof` rows remained unchanged. Independent inspection also confirms the owned OpenCode PID/root are gone, the protected endpoint is still present with the recorded identity, and no non-Apnea working-copy change exists.

## Medium — OpenCode was interrupted contrary to the package's exit procedure

The coder sent terminal `ctrl+c` rather than using OpenCode's required built-in `/quit`. `ctrl+c` delivers an interrupt signal to the foreground process, so the statement that no process was signaled is not accurate even though only the owned host was affected. It also bypassed the prescribed normal-exit lifecycle and left the EXIT cleanup incomplete until a later guarded manual removal. Rework must use the package's normal host exit and ownership-validated cleanup procedure rather than an interrupt.
