---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 7 package remains aligned with the approved plan. Round 11 uses only allowed provider/test paths and closes several coordinator/native gaps, but required cancellation, real multi-client, client lifecycle, and reconnect acceptance remains absent.

## Findings

### High — Cancellation/finalization and concurrent capacity semantics remain unproved

The Effect-native fixture now supports artwork blocking, result injection, failure, and call counting, and the new coordinator test proves pre/post authority, same-key joining, command/state progress, retry, and settled eviction. It does not prove:

- interruption during the admission/start boundary cannot leave ownership behind;
- interrupting/disconnecting the first caller does not cancel or strand joined callers;
- coordinator-scope shutdown interrupts a blocked provider read, settles every waiter, and removes/finalizes the entry before provider closure;
- distinct in-flight keys are capped and recover after a busy/failure slot is released.

These are explicit package requirements and previously defective paths. Add deterministic sentinels/counters for provider interruption/finalization and bounded tests that inspect settlement/retry after each race.

### High — Real server and explicit/reconnecting client lifecycle coverage is still missing

The package requires concurrent equal requests from different real clients, blocked-read isolation, post-read state change, provider failure/retry, unavailable/malformed/too-large wire outcomes, disconnect and disposal while pending, and final-response containment. The selected-server coverage still exercises only a sequential cache hit, pre-read mismatch, and unsupported peer.

There are still no explicit-client artwork tests for correlation, `CONNECTION_LOST`, or `DISPOSED`, and no reconnecting-client test proving a request is delegated once, never queued/replayed, and cannot settle from an old generation after replacement/disposal. Add these real socket/generation cases with bounded cleanup.

### Medium — Native execution failure coverage remains incomplete

Round 11 adds useful malformed JSON, null identifier, and noncanonical base64 cases. The adapter matrix still does not distinguish command timeout from ordinary nonzero failure or pair the artwork read with evidence that normal sample/stream commands continue using `--no-artwork`. Preserve the new strict cases and add the remaining package-specified timeout/compatibility assertions.

### Medium — Verification is partial after the Round 11 changes

The coder result reports 70 coordinator/system-media tests, typecheck, and `git diff --check`. It does not report the required focused four-file command, broad five-suite run, full Nx build/typecheck/test/format/package matrix after these edits, formatting, or boundary scan.

## Resolved findings

The Effect-native provider fixture now has artwork gates, failure/result controls, and call counts. Coordinator coverage establishes zero-call pre-stale behavior, one-call equal-key sharing, post-read stale discard, independent command/state progress, transient failure retry, capacity-one settled eviction, and re-read. Native tests now include malformed JSON, null native ID, and noncanonical base64 rejection.
