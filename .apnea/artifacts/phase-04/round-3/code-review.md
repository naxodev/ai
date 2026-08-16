---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package remains aligned with the approved plan. Round 3 stays within the allowed client and client-test paths and fixes terminal-to-disposed lifecycle behavior and the tested late-discovery handoff.

## Findings

### Critical — Interruption after healthy discovery but during guarded cleanup still leaks the client

The new generic Promise wrapper disposes a late resolved value only when that value itself contains a client (`packages/music-core/session/client.ts:792-823`). After discovery has already returned `{ type: "healthy", client, cleanup }`, the workflow separately awaits `discovery.cleanup()` at lines 867-876. If managed disposal interrupts during that cleanup and cleanup later succeeds, the Promise resolves `undefined`; `disposeLateClient` has no client to release, control never reaches line 877, and the already-handshaken client is neither returned nor disposed.

The added late-discovery test interrupts before discovery resolves, so it does not cover this second ownership gap. Make the healthy client scoped/guarded continuously from discovery completion through cleanup, marker release, and final handoff, and add a cancellation case that pauses successful cleanup after hello.

### High — Generation finalizers accumulate for the entire managed-client lifetime

Every successful generation is registered with `Effect.acquireRelease` in the supervisor's outer scope (`client.ts:1280-1288`). When a generation terminates, `#release(active)` only unsubscribes it; the scope finalizer retaining that explicit client remains registered until the managed client is finally disposed. Each reconnect therefore adds another retained client/finalizer, causing unbounded memory growth across daemon generations and repeated disposal only at final scope closure. Give each connect/adopt attempt bounded generation ownership that is closed/deregistered when that generation ends while preserving the disposal-vs-adoption handoff.

### Medium — The late-callback test mostly proves unsubscription, not generation fencing

After A terminates, `#release` removes its status/state/terminal listeners. The fixture's later `first.status`, `first.state`, and `first.terminal` calls iterate only the now-empty listener sets, so no stale callback actually enters the wrapper's token checks. Retain captured A callbacks (or queue them before unsubscription and deliver afterward) to prove stale callbacks that are already in flight cannot mutate B. The scripted old command also resolves successfully after A loss, unlike the explicit client's required indeterminate settlement; keep the controlled fixture faithful to that contract when testing late response behavior.

## Verification

The coder supplied passing focused, combined, full-target, timer-scan, and diff evidence (9 focused tests, 94 combined tests, 224 full tests). The prior terminal/disposal findings are covered, but the remaining cleanup-stage leak and lifetime finalizer accumulation are not.
