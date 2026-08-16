---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 8 package remains aligned with the approved plan. Round 5 stays within allowed adapter/test paths and production remains on the direct backend, but the artwork cleanup fix overreaches and the controller acceptance gaps remain.

## Findings

### High — Disposing one adapter deletes successful shared artwork used by another adapter

Round 5 retains `entry.owner` after successful completion and `removeArtworkInterests()` deletes every cache entry whose last worker was the disposed host (`packages/opencode-music-player/system-media.ts:259-278`). A settled metadata-cache entry is shared host-local presentation data, not pending ownership. If adapter A resolves artwork, adapter B consumes that cached value, and A then disposes, A deletes the shared entry even though B is current. B's next projection loses/restarts artwork work. This violates the requirement that disposal must not remove another controller generation's presentation ownership and regresses the existing metadata cache semantics.

On disposal, delete pending jobs owned by A and failed/null settled entries whose retry budget belongs to A. Preserve successful settled artwork (clear its worker owner rather than deleting it), and never alter entries/jobs owned by another host. Add an overlapping A-success → B-cache-hit → A-dispose test proving B retains the result and issues no replacement request.

### High — Adapter-backed controller behavior remains materially incomplete

Round 5 adds no controller tests. The session adapter/controller composition still lacks package-required proof for live playing/paused/idle projection and waveform fields, successful loading and optimistic play/pause/seek, failed command toast/loading, local seek coalescing without a second queue, degraded/unavailable and terminal feedback, observer exception isolation, and authoritative artwork merge by full identity.

Use a deterministic public-contract fake with held controls/artwork through `createSessionSystemMedia`; generic controller tests and adapter-only delegation tests do not prove this composition.

### High — Artwork ownership is still not exercised through the controller lifecycle

`artwork-lifecycle.test.ts` remains unchanged. The facade-level tests do not prove an old session native/resolver completion cannot merge into the controller's newer full provider identity or interfere with a newer presentation owner. Add the package's adapter-specific ownership case through the existing controller/artwork merge path, covering track/generation replacement and disposal while old native and resolver completions are held.

### Medium — Fake and lifecycle acceptance controls remain incomplete

The shared fake still lacks initial acquisition failure, held command outcomes, held native artwork across generation/disposal, disposed lifecycle emission, and deterministic exact replay/failure controls. Active disposal tests cover one held play and synchronous listener removal, but not held artwork/reconnect completion, repeated controller disposal, or late retained callbacks invoked after unsubscription. Several artwork tests still use `setTimeout(0)` rather than deterministic sentinels and do not settle held work in `finally` on assertion failure.

## Resolved findings

Round 5 now eagerly removes pending jobs owned by a disposed adapter and fences their late completion, so unique abandoned pending jobs no longer remain in `artworkJobs`. It also resets an exhausted null-result retry budget, and the new test proves a same-metadata replacement can start fresh work after A used all three attempts. The successful-settled deletion behavior above still needs narrowing.

## Verification

The package-cwd focused suite passes, and the Nx matrix reports 259 music-core plus 163 OpenCode tests with typecheck, format, and package checks green. Diff and selector inspections are clean. The exact root preload command remains unavailable in this checkout; the equivalent package-cwd suite passed. The verdict is based on the shared-cache regression and remaining package acceptance gaps.
