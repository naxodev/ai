---
status: done
---

## Rework completed

Resolved the round-5 synchronization and verification findings.

- Replaced check-then-mutate ownership operations with atomic `Ref.modify` transitions for reservation, adoption, terminal loss, terminal failure, token allocation, shutdown, lifecycle publication, and listener subscription/unsubscription.
- Transition results now carry old resources/listener snapshots out of the atomic Ref update; release/disposal and notification occur afterward.
- Listener collections are replaced immutably inside the lifecycle Ref rather than mutated directly.
- Shutdown atomically reserves disposal, increments the token, extracts active/pending resources, clears listeners, and installs `disposed` before resource cleanup/notification.
- Re-ran the complete target matrix with `NX_SKIP_NX_CACHE=true`, eliminating the stale-cache concern.

## Files touched

- `packages/music-core/session/client.ts`
- `.apnea/artifacts/phase-04/round-6/coder-result.md`

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

$ NX_SKIP_NX_CACHE=true bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
226 pass, 0 fail
953 expect() calls
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core
Cache: Skipped (--skip-nx-cache)

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
