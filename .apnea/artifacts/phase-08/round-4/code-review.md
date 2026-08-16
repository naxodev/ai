---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 8 package remains aligned with the approved plan, Round 4 stays within allowed paths, and production still selects the direct backend. Disposal and ownership coverage improved, but a pending-job leak and substantial controller/fake acceptance gaps remain.

## Findings

### High — Disposing an artwork owner leaves abandoned jobs and retry budget globally retained

The new completion fence prevents an inactive owner from mutating cache state, but disposal only calls `removeArtworkInterests(host)`. It does not clear entries whose `owner === host`. If no replacement requests the same metadata key, the old entry remains `pending` in `artworkJobs` forever after its resolver completes because the inactive completion handler returns before deleting the job. Repeated disposed adapters on distinct tracks can therefore grow the global jobs map without bound.

If a replacement later requests the same key, the lazy reset reuses the old entry and its consumed `attempts`; after the released owner consumed the third attempt, the replacement cannot start at all. On owner disposal, atomically detach/delete its pending job/cache entry (without touching another owner's entry or interests) so the old completion is fenced and a later owner gets a fresh bounded attempt budget. Add a test with no replacement proving job cleanup/retry, plus an attempts-exhausted A → B replacement case.

### High — Adapter-backed controller contract remains incomplete

Round 4 adds a useful active-disposal test, but no normal controller behavior was added. The adapter-backed controller suite still does not prove:

- live playing, paused, and idle projection with waveform fields;
- successful loading and optimistic play/pause/seek behavior;
- failed-command toast/loading behavior through the adapter;
- local seek coalescing without an adapter queue;
- degraded/unavailable and terminal feedback in the controller store;
- observer exception isolation;
- authoritative artwork completion merging only for the full current identity.

Use a deterministic, public-contract fake with held commands/artwork rather than inline `any` clients, and exercise these existing controller contracts through `createSessionSystemMedia`. Generic backend tests plus adapter unit tests do not prove their composition as required by the package.

### High — Artwork lifecycle ownership is not proved through the controller/presentation contract

The new system-media test proves a late resolver cannot overwrite a replacement adapter's facade cache/presentation in its chosen sequence. `artwork-lifecycle.test.ts` remains unchanged, and there is still no controller-level test where an old session native/artwork completion races a new full provider identity and presentation owner. The package specifically requires proving that late session work cannot clean up or overwrite newer image ownership while preserving the new owner's completion.

Add the adapter-specific ownership assertion through the existing artwork/controller merge contract, including held native rejection/result and held resolver completion after track/generation change and disposal.

### Medium — The deterministic fake/adapter matrix still lacks acquisition and held-outcome controls

There is no initial factory rejection assertion, held command support in the shared public-contract fake, held native artwork completion across generation/disposal, disposed lifecycle outcome, or exact failure replay to multiple/late subscribers. Several tests use wall-clock `setTimeout(0)` instead of deterministic sentinels and do not settle pending work in `finally` on assertion failure. Complete the fake controls and use deterministic cleanup as specified by the package.

## Resolved findings

Disposed adapters now reject state/presentation subscriptions as inert, and post-disposal player/control calls do not reach the client. Active controller disposal unsubscribes state/status/connection before releasing the client, settles queued callers, prevents the next command, and suppresses late store/toast/timer changes. Artwork completion now checks active owner identity, and the A/B same-metadata test proves the covered stale resolver cannot replace B's result. The prior controller error-owner concern does not remain: cached refresh preserves non-null owned errors, while authoritative snapshots/successful commands perform the existing reconciliation.

## Verification

The package-cwd focused suite passes and the Nx matrix reports 259 music-core plus 162 OpenCode tests with typecheck, format, and package checks green. Diff and selector inspections are clean. The exact root preload command remains unreported/unrunnable in this checkout; the equivalent package-cwd suite passed. The verdict is based on the resource leak and missing acceptance above.
