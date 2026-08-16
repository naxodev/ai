---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 9 package remains aligned with the approved plan. Round 2 stays within allowed OpenCode paths, retains the production session selector, and fixes the snapshot/optimism race. Two production artwork-admission races and lifecycle error restoration remain incorrect.

## Findings

### High — Deferred artwork can remain stuck forever when capacity is freed by disposal

A full job set adds one callback per host to `waitingArtwork`. Waiting work is admitted only from `settleArtworkEntry()`. When an active job owner disposes, `removeArtworkInterests()` deletes its job from `artworkJobs` but never admits a waiter. Capacity is free, yet the current waiting track remains `artwork_loading: true` forever because production has no polling/reprojection lane.

Centralize slot release/admission and invoke it after both normal settlement and owner disposal/cancellation. Add a 32-job test where one active owner disposes rather than resolves and prove the waiting current identity starts, publishes, and is removed on its own disposal.

### High — Multiple hosts waiting for the same key do not share completion

`waitingArtwork` stores host-local retry callbacks, not key-based interests. With capacity full, two adapters waiting for the same metadata key occupy separate entries. When a slot frees, A starts the job. When A completes, B's retry finds A's settled cache hit, returns it from `artworkForTrack()`, and discards that return value; B was never registered in `entry.interests`, so B receives no completion event and remains projected as loading forever.

Represent deferred admission by key with bounded host interests, or make retry publish an immediate cache-hit completion to the waiting host. Prove two same-key waiters cause one native/resolver job and both leave loading with the same correlated presentation result.

### High — Provider lifecycle feedback is lost after a transport error clears

The new lifecycle `source` prevents a provider event from overwriting a current transport error, but the controller discards that provider state entirely. Example: provider becomes degraded while a transport error is displayed; the provider event is ignored. A later successful command calls `setError(null)`, but the adapter deduplicates the unchanged degraded lifecycle and never republishes it. The UI now shows no error even though provider degradation remains active. The same loss occurs when a transport error temporarily overrides an already-visible degraded status and then succeeds.

Retain lifecycle and transport error state independently and derive the displayed precedence. Clearing transport-owned feedback must restore the current provider/connection message, while connection terminal/reconnect remains authoritative. Add both event orderings and provider-unavailable cases.

### Medium — Settled artwork eviction and waiting cleanup remain unproved

Round 2 restores equal-key sharing, retry, 32-job admission, rejection fallback, and A/B completion tests, but still does not prove the deterministic 32-entry settled-cache eviction/hit policy. It also does not assert that all `waitingArtwork` entries disappear after completion/disposal. Add boundary tests so the new global waiting structure cannot become a retained host queue.

### Medium — Some cutover command/lifecycle cases remain narrower than the package

The controller tests now cover snapshot fencing and artwork merge, but do not directly prove an unissued latest seek is canceled without replay on reconnect, overlapping command failure/loading ownership, or successful transport restoration of degraded provider feedback. Add these while fixing the lifecycle issue above.

## Resolved findings

A snapshot epoch now prevents late play/pause/seek success from mutating a newer daemon snapshot. The package-load test now constructs `createSessionSystemMedia` with a deterministic client and proves one backend/client across both slots, degraded daemon feedback, and exact disposal. Round 2 also restores rejected artwork fallback, equal-key sharing/retry, 32-active-job admission with one deferred current identity, held A/B completion fencing, controller artwork merge, and held artwork/reconnect disposal coverage.

## Verification

The focused package suite passes 24 tests and the Nx matrix passes with 259 music-core and 121 OpenCode tests. Both forbidden-source scans and `git diff --check` are clean. Production contains no direct provider/probe/stream/sample/poll/playback-clock/native-command ownership. The verdict is based on the source races above.
