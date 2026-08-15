---
status: done
---

## Changed

- Added a shutdown-only server test seam that exercises the production acceptance callback after `closing` is set; the socket is synchronously destroyed rather than enrolled.
- Added an executable subprocess test: `SIGTERM` closes the real listener, an injected filesystem permission failure makes unlink fail, and the daemon exits nonzero with the tagged socket operation in diagnostics.
- Retained tagged daemon diagnostics at the process boundary and made the older focused socket tests failure-safe with `try`/`finally` cleanup.

## Files touched

- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/tests/session-server.test.ts`
- `.apnea/artifacts/phase-03/round-3/coder-result.md`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-server.test.ts
exit 0 — 25 pass, 0 fail

$ bun test packages/music-core/tests/session-coordinator.test.ts packages/music-core/tests/system-media.test.ts
exit 0 — 65 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0 — all 5 music-core targets passed; test target: 152 pass, 0 fail

$ ! rg -n "Effect\.runSync|setTimeout\(|setInterval\(" packages/music-core/session/coordinator.ts packages/music-core/session/provider.ts packages/music-core/session/server.ts
exit 0

$ ! rg -n "startMusicSessionServer" packages/music-core/session/music-sessiond.ts
exit 0

$ ! rg -n "Effect\.repeat\(Effect\.yieldNow|setTimeout\(|new Promise\(.*setTimeout|Date\.now\(" packages/music-core/tests/session-server.test.ts
exit 0

$ jj diff --summary
exit 0 — product changes remain confined to the Phase 3 server, executable, and server-test files; pre-existing .apnea worktree artifacts and .apnea/state.json remain untouched.
```

## Residual risks

The executable cleanup-failure test uses POSIX directory permissions and is therefore intentionally machine-local, matching this macOS Unix-socket phase. No commits were made and `.apnea/state.json` was not edited.
