---
status: done
---

## Changed

- Scoped listener registration, owned-path cleanup, server close, and accepted connection supervision.
- Bounded connection input; made queue shutdown effectful; scoped exact socket listeners and EOF framer finalization.
- Destroyed accepted sockets once shutdown begins and made connection enrollment server-supervised.
- Replaced server-test timestamp path uniqueness with `randomUUID`.

Files touched:
- `packages/music-core/session/server.ts`
- `packages/music-core/tests/session-server.test.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-server.test.ts
exit 0 — 4 pass, 0 fail

$ bun test packages/music-core/tests/session-coordinator.test.ts packages/music-core/tests/system-media.test.ts
exit 0 — 65 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0 — build, typecheck, test, format:check, and package:check passed

$ ! rg -n "Effect\.runSync|setTimeout\(|setInterval\(" packages/music-core/session/coordinator.ts packages/music-core/session/provider.ts packages/music-core/session/server.ts
exit 0

$ ! rg -n "startMusicSessionServer" packages/music-core/session/music-sessiond.ts
exit 0

$ ! rg -n "Effect\.repeat\(Effect\.yieldNow|setTimeout\(|new Promise\(.*setTimeout|Date\.now\(" packages/music-core/tests/session-server.test.ts
exit 0

$ jj diff --summary
exit 0 — only approved Phase 3 product/test paths changed; pre-existing `.apnea/state.json` remains untouched.
```

## Residual risks

- Focused tests retain existing four server integration cases; broader Phase 3 lifecycle/error-injection matrices remain to be added in subsequent rounds.
