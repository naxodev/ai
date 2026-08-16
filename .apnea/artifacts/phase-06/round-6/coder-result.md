---
status: done
---

## Changed

- Hardened the isolated oversized-provider-state child fixture’s failure cleanup: stderr is consumed concurrently, a timed-out child is killed and its exit awaited, and selected socket/bind artifacts are asserted absent after child cleanup.
- Kept the real selected encode/local-close path and bounded overflow assertion; enlarged the fixture’s margin so the oversized provider state is unambiguously above the configured frame bound.

## Files touched

- `packages/music-core/tests/session-server.test.ts`
- `.apnea/artifacts/phase-06/round-6/coder-result.md`

## Verification

```text
$ bun test packages/music-core/tests/session-server.test.ts -t 'oversized provider state'
exit 0 — 1 pass, 0 fail

$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts -t '24|slow reader|backpressure|overflow'
exit 0 — 5 pass, 0 fail

$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0 — 135 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0 — 242 pass, 0 fail; build, typecheck, format, and package check passed

$ ! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts
exit 0

$ git diff --check
exit 0
```

## Residual risks

- The fixture proves the selected coordinator remains callable after the local oversized-peer close, but it still does not establish the review-requested fresh healthy explicit-client state update and protocol command settlement after a bounded provider snapshot is restored. Attempts to add that topology exposed delayed stale provider-state replay in the isolated Bun child; this requires a deterministic selected-graph synchronization seam rather than a sleep/poll loop.
- No commit, push, or `.apnea/state.json` edit was performed.
