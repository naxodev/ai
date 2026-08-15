---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 1 package matches the approved plan. The product diff is confined to `server.ts` and `session-server.test.ts`, uses the shared selected graph, and does not add Phase 2 process-contender or Phase 3 startup-matrix acceptance.

## Findings

### High — The split graph now reports ready before its provider event subscription is acquired

`packages/music-core/session/server.ts:911-916` relies on a single `Effect.yieldNow` to let coordinator-owned fibers acquire the provider event stream before setting `active` and returning the server service. That is not an ownership/readiness guarantee. The regression is visible in this phase's test diff: three existing assertions were weakened from one event-source disposal to zero (`packages/music-core/tests/session-server.test.ts:632-635`, `1315-1317`, and `1345-1349`). Even the pre-hello case performs a real connection before close, yet the selected coordinator can still finish server startup without ever acquiring its event subscription.

This changes retained baseline behavior and creates a window where the server is returned/accepting while provider events can be missed. Preserve the prior exact-once subscription/finalization assertions and make selected-graph readiness deterministic; do not use scheduler yielding or changed expectations as a substitute for proving the coordinator's required event ownership is live.

## Verification

The coder supplied all package verification results: the focused selected-topology test passed, the complete server suite reported 35 passing tests, all `music-core` build/typecheck/test/format/package targets passed with 203 tests, the timer scan passed, and `git diff --check` passed. Those results validate the deadlock regression itself but include the weakened event-lifecycle assertions above.
