---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 8 package remains aligned with the approved plan and all Round 3 paths are allowed. Production still selects the direct backend. The adapter's retained lifecycle improved, but disposal/artwork ownership and controller acceptance remain incomplete.

## Findings

### High — Subscribing after adapter disposal replays state and starts artwork work

`createSessionSystemMedia.subscribe()` does not check `disposed` (`packages/opencode-music-player/system-media.ts:569-588`). After disposal it adds the listener, calls `project(latest)`, and synchronously replays snapshot/lifecycle state. For a tracked state, `project()` can also enter `artworkForTrack` and start resolver/catalog work after disposal. This violates the requirement that disposal suppress all late state/status/artwork/reconnect work.

After disposal, subscription APIs must return an inert idempotent disposer without adding listeners, replaying retained state, or creating artwork interests/jobs. Add tests that subscribe and call all adapter surfaces after disposal and prove zero callback/work/client activity.

### High — Late disposed artwork still mutates the shared cache and can publish under a newer identity

Round 3 catches native rejection and removes the disposed host's interests, but the shared `artworkForTrack` job still executes its fulfillment handler after disposal: it mutates `activeEntry`, inserts it into the global metadata cache, and publishes to any interests subsequently added by another host. The new test proves only that the disposed host receives no presentation event; it does not prove resolver completion/cache mutation is suppressed or that a newer controller sharing the metadata key cannot receive/consume the old generation's completion.

This is exactly the missing `artwork-lifecycle.test.ts` ownership case. Add a held session resolver, dispose generation A, establish generation B/current identity with the same metadata key, then complete A. Prove A cannot overwrite B's cache/presentation or publish using B's provider identity, while disposing A does not remove B's independently owned interest/job. The implementation needs generation/entry ownership rather than only host-listener suppression.

### High — Adapter-backed controller acceptance remains materially incomplete

The controller test now covers A replay, reconnect retention, lower-revision B, and transport-error ownership ordering. It still does not prove the package-required adapter composition for live playing/paused/idle state, successful control loading and optimistic play/pause/seek, failed command toast/loading, local seek coalescing, waveform fields, degraded/terminal feedback, listener exception isolation, or held command completion after disposal. The inline client remains typed `any` rather than reusing a deterministic public-contract fake with held controls.

Add focused adapter-backed controller tests for these existing contracts. In particular, resolve a held command after controller disposal and prove no store mutation, toast, reconciliation timer, or next queued command starts.

### High — Active disposal and late-callback lifecycle coverage is still incomplete

The new lifecycle test covers disposal before client acquisition. It does not dispose an installed adapter through the controller and then fire retained state/status/connection callbacks, held command completion, held artwork, and reconnect completion. Nor does it assert exact-once state/status/connection/presentation unsubscription before client disposal through the controller. System-media assertions alone do not prove controller fencing and caller settlement.

Add the active and repeated-disposal cases required by `controller-lifecycle.test.ts`, with deterministic completion of all held work in `finally`.

### Medium — Controller error ownership can remain stale after a successful cached refresh

A successful `requestRefresh()` clears a transport-owned displayed error when `errorOwner !== "lifecycle"`, but it does not reset `errorOwner` to `null` (`packages/opencode-music-player/index.tsx:218-227`). The store and ownership marker can therefore disagree until a later snapshot or successful command. Clear the matching ownership atomically with the displayed error and test subsequent lifecycle transitions.

## Resolved findings

Round 3 deduplicates effective lifecycle transitions, replays retained state/lifecycle to late active subscribers, centralizes listener isolation, preserves newer transport failures across a connected transition, maps non-available and rejected native artwork to host fallback, returns one disposal Promise, and adds exact adapter unsubscription/disposal counters. These changes address the prior precedence, duplicate acquisition, and repeated-disposal findings for the covered paths.

## Verification

The exact root preload command still exits 1 because Bun cannot resolve the preload from the repository root. The package-cwd equivalent passes 60 tests, and the Nx matrix passes 259 music-core plus 159 OpenCode tests with typecheck, format, and package checks green. Diff and selector inspections are clean. The verdict is based on the remaining behavior and acceptance gaps above.
