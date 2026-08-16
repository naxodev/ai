---
status: done
---

## Changed

Fixed the Phase 3 live-marker security regression and the concurrent marker-publication race.

- Restricted live-marker authorization to only a same-owner Unix socket with a non-`0600` mode: the narrow listener pre-hardening window. Regular files, symlinks, directories, and foreign-owned sockets remain terminal unsafe artifacts even when a valid live marker exists.
- Added combined live-marker coverage for file, symlink, directory, and simulated foreign-socket artifacts. Each is rejected as `MusicSessionRuntimeError`, with both marker and socket identity unchanged and no cleanup invoked.
- Diagnosed the concurrent 20-client failure as a reader observing the empty marker between `open(..., "wx")` and payload write. Marker acquisition now writes and syncs a private same-directory file, then atomically publishes it via `link`; readers only observe complete marker JSON. Temporary marker files are removed after publication/contended acquisition.
- Extended 20-client cleanup assertions to reject leaked marker temporary files. The real convergence test passed five consecutive isolated runs after this correction.

## Files touched

- `packages/music-core/session/config.ts`
- `packages/music-core/tests/session-client.test.ts`
- `.apnea/artifacts/phase-03/round-4/coder-result.md`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts -t 'live marker cannot mask'
exit 0
1 pass, 0 fail
16 expect() calls

$ bunx nx run music-core:typecheck
exit 0
NX Successfully ran target typecheck for project music-core

$ for i in 1 2 3 4 5; do bun test packages/music-core/tests/session-client.test.ts -t '20 concurrent managed callers' || exit 1; done
exit 0
5 consecutive runs: 1 pass, 0 fail each

$ bun test packages/music-core/tests/session-client.test.ts -t 'TestClock|20 concurrent|marker.*release|launcher rejection|primary startup|incompatib|does not relaunch|live marker cannot mask'
exit 0
13 pass, 0 fail
93 expect() calls

$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
86 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
216 pass, 0 fail
894 expect() calls
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
