---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package remains aligned with approved Plan Phase 3, and the product diff remains confined to `packages/pi-music-dock/scripts/package-smoke.ts`.

## Findings

### High — Pi process-group exit does not prove that RPC mode left no detached daemon

`packages/pi-music-dock/scripts/package-smoke.ts:267-301,356-363` confirms only the process group rooted at the Pi child before deleting the isolated install. A music-session daemon would not belong to that group: the installed core launcher intentionally starts it with `detached: true` and ignored stdio (`packages/music-core/session/client.ts:823-827`). If a regression caused the packed extension to acquire its session client in RPC mode, the Pi group could still exit zero while a detached daemon/provider continued running, and the smoke would remove the root beneath that process and print cleanup success.

This misses the phase package's explicit acceptance that RPC mode must not start or retain a client, daemon, or provider and that any daemon/provider appearance is a failure. Add a non-destructive observation tied to this smoke's isolated install/runtime (or a before/after ownership delta) that fails before root removal if RPC spawned an independently detached daemon/provider. Do not use broad process cleanup; if an owned process cannot be confirmed gone, retain/report the root.

## Resolved Round 1 findings

The prior findings are fixed: failed termination now captures pipe output under a bound before reaching outer cleanup, and installed exact Pi versions are validated against peer ranges read from the packed dock manifest as well as the source policy.

## Verification

The coder supplied successful evidence for all four phase verification commands. The happy path proves the exact isolated Pi binary, packed roots, command registration, bounded Pi-group exit, and normal root cleanup, but it contains no evidence that an independently detached music-session daemon/provider did not appear.
