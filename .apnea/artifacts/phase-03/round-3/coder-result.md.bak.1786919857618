---
status: done
---

## Changed

Fixed the round-2 detached-daemon leak in `packages/music-core/tests/session-client.test.ts`.

- The primary-timeout-plus-marker-release-failure test now injects a bounded no-op launcher and asserts exactly one launch attempt. It still exercises the authoritative workflow's owned-marker acquisition, pending retry, typed timeout, and secondary release diagnostic without invoking the production detached launcher.
- Accounted for the prior leaked process before verification: verified PID `25627` was the leaked packaged `music-sessiond.js`, terminated that exact process, and confirmed its default managed socket was removed.
- Added an end-of-verification assertion that the default managed socket is absent, confirming this test run left no daemon/runtime artifact behind.

## Files touched

- `packages/music-core/tests/session-client.test.ts`
- `.apnea/artifacts/phase-03/round-3/coder-result.md`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts -t 'primary startup failure'
exit 0
1 pass, 0 fail
5 expect() calls
$ test ! -e "/tmp/naxodev-music-$(id -u)/s.sock"
exit 0

$ bun test packages/music-core/tests/session-client.test.ts -t 'TestClock|20 concurrent|marker.*release|launcher rejection|primary startup|incompatib|does not relaunch'
exit 0
12 pass, 0 fail

$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
85 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
215 pass, 0 fail
877 expect() calls
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/client.ts
exit 0

$ test ! -e "/tmp/naxodev-music-$(id -u)/s.sock"
exit 0

$ jj diff --summary
exit 0
M packages/music-core/session/client.ts
M packages/music-core/session/config.ts
M packages/music-core/tests/session-client.test.ts
(unrelated pre-existing phase artifacts/tasks and .apnea/state.json remain dirty and untouched)

$ jj diff --git packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
Only the existing Phase 3 config/client work and session-client tests appear in the inspected package paths.

$ git diff --check
exit 0
```

## Residual risks

- Focused/full runs emit intentional bounded warnings for injected marker-release failures and the existing injected server-unlink failure; all commands exit successfully.
- No commit, push, or `.apnea/state.json` edit was performed.
