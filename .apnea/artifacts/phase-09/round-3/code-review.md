---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 9 package remains aligned with the approved plan. Round 3 stays within allowed OpenCode paths, preserves the production session selector, and resolves the previously reported snapshot, slot-release, shared-waiter, lifecycle-restoration, and eviction findings. One deferred-artwork ownership race remains.

## Findings

### High — A deferred key can execute the disposed first waiter's client/resolver for a surviving waiter

`DeferredArtwork` stores one `admit` closure when the key is first deferred (`packages/opencode-music-player/system-media.ts:186-232`). That closure captures the first adapter's `native`, `resolver`, `target`, and timing functions. Interests are tracked separately by host.

If host A creates the deferred key, host B joins it, and A disposes or changes identity before a slot frees, `removeWaitingInterest(A)` correctly removes A while preserving B. But admission chooses B as `leaderHost` and then calls the closure still captured from A. The job is owned/published as B, while its native callback and resolver belong to disposed A. In practice A's native callback returns no bytes after disposal, B's `client.artwork` is never called, and A's catalog resolver can populate/publish a result under B's identity.

Store the complete invocation context per interested host, or replace the deferred leader context whenever its host is removed. Admission must call the selected live leader's own native callback/resolver/target and then attach the remaining equal-key interests. Add a capacity test where A and B wait on one key, A disposes before admission, and capacity frees; require zero late A native/resolver calls, exactly one B native/resolver call, and a B-correlated completion.

### Medium — Overflow behavior beyond the deferred-interest bounds lacks a stable assertion

The deferred map and per-key interests are each capped at 32. A 33rd deferred key or 33rd host for one key is dropped with `loading: false` and receives no fallback/completion unless a future authoritative snapshot happens. This is finite, but the production no-poll design makes that degradation permanent for an unchanged current track. Add an explicit boundary assertion and document/implement the intended stable outcome (for example, bounded immediate no-artwork completion or another finite recovery policy) rather than silently depending on a future snapshot.

## Resolved findings

Round 3 now:

- admits deferred work when capacity is freed by normal completion or owner disposal;
- groups equal deferred work by key and correlates completion to retained interests;
- caps active jobs, deferred keys, per-key interests, and settled cache entries;
- proves normal-release and disposal-release admission plus FIFO settled eviction;
- retains connection/provider lifecycle state independently from transport errors and restores degraded/unavailable feedback after transport recovery;
- proves overlapping loading, canceled unissued seek behavior on reconnect, snapshot-authoritative optimism, production package client sharing, and exact disposal.

## Verification

The focused package suite passes 29 tests and the Nx matrix passes with 259 music-core and 126 OpenCode tests. Both forbidden-source scans and `git diff --check` are clean. OpenCode production contains no direct provider/probe/stream/sample/poll/playback-clock/native-command ownership. Approval is blocked only by the deferred-leader race and its boundary semantics above.
