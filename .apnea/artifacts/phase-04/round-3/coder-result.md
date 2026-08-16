---
status: done
---

## Rework completed

Resolved all Phase 4 round-2 review findings.

- Made Promise-backed Phase 3 discovery/hello handoffs cancellation-safe: if an interrupted Effect operation later resolves with an explicit client (or a discovery result containing one), it disposes that client rather than losing socket ownership.
- Added deterministic proof of that real `connectOrStartMusicSessionEffect` path: a controlled late healthy discovery resolves after managed disposal and its client is disposed.
- Kept natural failure terminal until caller action, but made explicit caller/scope disposal publish the required `disposed` lifecycle transition even after an incompatibility terminal state.
- Extended the controllable generation fixture with status, state, terminal, and transport-response controls.
- Added A → reconnecting → B fencing coverage for retained status/state replay, idempotent unsubscription, lower-revision B replay, late A status/state/terminal suppression, and a late A transport response not settling a later B command.

## Files touched

- `packages/music-core/session/client.ts`
- `packages/music-core/tests/session-client.test.ts`
- `.apnea/artifacts/phase-04/round-3/coder-result.md`

No commit, push, `.apnea/state.json`, server, protocol, config, host, packaging, or documentation changes were made.

## Verify transcript

```text
$ bunx nx run music-core:typecheck
exit 0
NX Successfully ran target typecheck for project music-core

$ bun test packages/music-core/tests/session-client.test.ts -t 'reconnect|replacement generation|indeterminate'
exit 0
9 pass, 0 fail
56 expect() calls

$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
94 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
224 pass, 0 fail
947 expect() calls
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/client.ts
exit 0

$ jj diff --summary
exit 0
Phase source changes remain restricted to music-core index/client/client-test paths. Existing unrelated .apnea metadata/tasks and .apnea/state.json remain dirty and untouched.

$ jj diff --git packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/protocol.ts packages/music-core/index.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0

$ git diff --check
exit 0
```

## Residual risks

- Existing injected cleanup and marker-release test warnings still appear during the suite; all commands exit successfully.
- The public core index intentionally continues to omit the test-only reconnect connector seam.
