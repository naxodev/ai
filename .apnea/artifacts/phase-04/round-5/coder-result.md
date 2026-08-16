---
status: done
---

## Rework completed

Resolved all round-4 review findings in the Phase 4 client/test scope.

- Added an interruption-safe ownership transfer between connector success and adoption. The supervisor keeps connector acquisition interruptible, then uses `Effect.uninterruptibleMask` to reserve the completed explicit client before interruption can win; managed shutdown owns and disposes that pending handoff.
- Added deterministic reservation-to-adoption race coverage: disposal triggered exactly after reservation disposes the completed B client and leaves the managed lifecycle disposed.
- Moved managed lifecycle data—generation token, active/pending clients, terminal/disposed state, retained status/state, lifecycle, and listener collections—behind one synchronous Effect `Ref`. Promise-facing getters remain synchronous snapshots, while transitions use `Ref.update`.
- Preserved bounded ownership without retaining one scope finalizer per historical generation.

## Files touched

- `packages/music-core/session/client.ts`
- `packages/music-core/tests/session-client.test.ts`
- `.apnea/artifacts/phase-04/round-5/coder-result.md`

No commit, push, `.apnea/state.json`, server, protocol, config, host, packaging, or documentation changes were made.

## Verify transcript

```text
$ bunx nx run music-core:typecheck
exit 0
NX Successfully ran target typecheck for project music-core

$ bun test packages/music-core/tests/session-client.test.ts -t 'reservation|reconnect|replacement generation|indeterminate'
exit 0
11 pass, 0 fail
62 expect() calls

$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
96 pass, 0 fail
538 expect() calls

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
225 pass, 0 fail
950 expect() calls
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
- The public core index intentionally omits the test-only reconnect connector seam.
