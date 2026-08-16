---
status: done
---

## Rework completed

Resolved the round-6 disposal-ownership finding.

- Moved interrupt owner, scope closer, and the one shared disposal completion into `ManagedLifecycleState`.
- `dispose()` now atomically reserves a completion and extracts exactly one closer through `Ref.modify` before invoking it. Concurrent and reentrant callers receive the same completion promise.
- Added deterministic lifecycle-listener coverage proving a reentrant `dispose()` call and a concurrent caller neither start another close nor receive a distinct completion; active ownership is closed before that completion resolves.

## Files touched

- `packages/music-core/session/client.ts`
- `packages/music-core/tests/session-client.test.ts`
- `.apnea/artifacts/phase-04/round-7/coder-result.md`

No commit, push, `.apnea/state.json`, server, protocol, config, host, packaging, or documentation changes were made.

## Verify transcript

```text
$ bunx nx run music-core:typecheck
exit 0
NX Successfully ran target typecheck for project music-core

$ bun test packages/music-core/tests/session-client.test.ts -t 'dispose-once|reservation|reconnect|replacement generation|indeterminate'
exit 0
12 pass, 0 fail
65 expect() calls

$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
97 pass, 0 fail
541 expect() calls

$ NX_SKIP_NX_CACHE=true bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
227 pass, 0 fail
956 expect() calls
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core
Cache: Skipped (--skip-nx-cache)

$ ! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/client.ts
exit 0

$ jj diff --summary
exit 0
Phase source changes remain restricted to music-core index/client/client-test paths. Existing unrelated .apnea metadata/tasks and .apnea/state.json remain dirty and untouched.

$ git diff --check
exit 0
```

## Residual risks

- The first uncached matrix attempt encountered the pre-existing 20-client Phase 3 convergence race (`occupied`); its isolated test passed five consecutive times, the direct combined suite passed, and a second uncached full matrix passed. Nx reported the task as flaky.
- Existing injected cleanup and marker-release test warnings still appear during the suite; all reported successful commands exit cleanly.
- The public core index intentionally omits test-only reconnect seams.
