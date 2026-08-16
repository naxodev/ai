---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 8 package is a coherent expansion of the approved Phase 8 plan and keeps production selection unchanged. The implementation stays within allowed OpenCode paths, but it does not yet satisfy the package's lifecycle/controller/artwork acceptance.

## Findings

### High — Provider and connection lifecycle messages overwrite each other and are cleared by cached polling

The adapter emits provider status and connection lifecycle independently as the same `{ type: "lifecycle", message }` event (`packages/opencode-music-player/system-media.ts:470-482`). A ready provider status can clear an active reconnect/terminal error, and a `connected` event can clear a degraded/unavailable provider message. Initial installation also emits replayed state/status/connection once through the public subscription callbacks and then emits all three again at lines 484-488, producing duplicate snapshots/lifecycle work.

The controller has no lifecycle-error ownership. `requestRefresh()` calls the adapter's cached `player()` during reconnect and clears any non-transport error (`packages/opencode-music-player/index.tsx:213-224`), so the actionable reconnect/terminal message can disappear on the next unchanged-state poll without a connected replacement.

Combine retained status and connection state with explicit precedence, emit one transition per replay/change, and preserve lifecycle-originated errors until the corresponding connected/ready transition clears them. Test ready + reconnecting, degraded + connected, terminal retention, connected-B recovery, and intervening cached polls.

### High — The required controller contract is not tested with the session adapter

No `controller.test.ts` case was added and the only controller-lifecycle addition uses an ad-hoc backend, not `createSessionSystemMedia`. The package requires adapter-backed proof of initial/live/replacement replay, reconnect/terminal feedback, loading and failures, optimistic play/pause/seek, local seek coalescing, waveform fields, listener exception isolation, and late command suppression. None of those controller integration paths is exercised.

Inject the real adapter factory with the deterministic public-contract fake through `createBackend` and prove the existing controller behavior, including lower-revision generation B replay and no second adapter queue/replay.

### High — Artwork and disposal acceptance is largely missing

The only session artwork test covers `available`. There is no evidence for `unavailable`, `stale`, `too-large`, rejection/disconnect, catalog fallback arguments, retries, old-generation/old-identity completion suppression, or disposal preventing resolver/presentation publication. `artwork-lifecycle.test.ts` is unchanged, so the required newer-presentation ownership case is absent.

Likewise, active-client exact-once unsubscription/disposal, held state/status/command/artwork callbacks after disposal, repeated asynchronous backend disposal, and controller suppression of late toast/timer/next-command work are untested. Extend the fake with held outcomes and exact subscription/disposal counters, and add the package-listed lifecycle/artwork tests with all work settled in `finally`.

### Medium — Factory/disposal identity semantics are incomplete

The production factory uses the constant client ID `"opencode-music-player"` for every adapter instance rather than a unique stable ID per adapter/process. Also, `dispose()` returns `undefined` on repeated calls instead of retaining the first pending disposal Promise, so concurrent disposal callers cannot observe the same async completion. Generate one stable unique ID for each adapter-owned client and retain/return one disposal operation while releasing the client exactly once.

### Medium — Factory failure can broadcast duplicate lifecycle events

Every backend `subscribe()` attaches its own rejection handler to `clientPromise`, and each handler calls `emit`, which broadcasts to all listeners. With N listeners, one acquisition failure can therefore publish N duplicate lifecycle events to each listener. Observe acquisition failure once at adapter ownership and replay/store its lifecycle state for subscribers.

## Verification

The package-cwd four-file suite reports 54 passing tests and the final Nx matrix reports 259 music-core plus 153 OpenCode tests with typecheck, format, and package checks green. `git diff --check` and selector inspection are clean. The exact root preload command did not run in this checkout; the equivalent package-cwd command and Nx target passed. Verification is green for current coverage, but the required adapter/controller/lifecycle matrix above is absent.
