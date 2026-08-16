---
status: done
---

## Changed

- Reverted the out-of-package transport-only capability negotiation, client validation, server forwarding, and related baseline test changes from Round 7; `state-replay` remains mandatory.
- Retained bounded child-process cleanup and added a target connection-finalization barrier before the oversized fixture’s local-containment assertion.

## Verification

```text
$ bun test packages/music-core/tests/session-server.test.ts -t 'oversized provider state'
exit 0 — 1 pass

$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts -t '24|slow reader|backpressure|overflow'
exit 0 — 5 pass

$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0 — 135 pass

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 1 — build, typecheck, format, and package check passed; 241 pass / 1 fail.
The existing timing-sensitive `20 concurrent managed callers converge on one selected graph` startup test failed once with an occupied-peer startup error. The immediately prior combined three-suite run passed.

$ ! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts
exit 0

$ jj diff --summary && git diff --check
exit 0
```

## Residual risks

- The required normal state-replay healthy-peer regression remains unproven. A child fixture that subscribes to the existing coordinator state stream before emitting the bounded replacement snapshot times out after the oversized target has finalized; no sleep or polling workaround was retained.
- No commit, push, or `.apnea/state.json` edit was performed.
