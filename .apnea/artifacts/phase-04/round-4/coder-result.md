---
status: done
---

## Rework completed

Resolved all round-3 review findings within the Phase 4 client/test scope.

- Kept a healthy discovered explicit client under `Effect.onInterrupt` ownership through cleanup, marker-release, and return handoff. Interruption while a successful guarded cleanup is still pending now disposes that already-handshaken client.
- Removed the supervisor-wide `acquireRelease` registration for every generation. Generation ownership is now released by normal active-generation handling rather than accumulating finalizers for the managed client's lifetime.
- Added deterministic coverage for cancellation during successful healthy cleanup, in addition to the prior late-discovery handoff.
- Strengthened the controllable generation fixture and race test: queued A callbacks are captured before unsubscription and delivered after B adoption, proving token fences—not only unsubscription—suppress stale status/state/terminal callbacks. Its in-flight command now faithfully rejects as `INDETERMINATE_COMMAND`; the B command settles only from B.

## Files touched

- `packages/music-core/session/client.ts`
- `packages/music-core/tests/session-client.test.ts`
- `.apnea/artifacts/phase-04/round-4/coder-result.md`

No commit, push, `.apnea/state.json`, server, protocol, config, host, packaging, or documentation changes were made.

## Verify transcript

```text
$ bunx nx run music-core:typecheck
exit 0
NX Successfully ran target typecheck for project music-core

$ bun test packages/music-core/tests/session-client.test.ts -t 'reconnect|replacement generation|indeterminate'
exit 0
10 pass, 0 fail
59 expect() calls

$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
95 pass, 0 fail

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
