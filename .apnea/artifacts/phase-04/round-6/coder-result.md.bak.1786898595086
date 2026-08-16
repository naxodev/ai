---
status: done
---

## Changed

Restored the Phase 4 module boundary:

- `config.ts` now exposes an opaque `ManagedRuntimeProbe` capability that retains private filesystem identity proofs and guarded cleanup construction.
- `client.ts` owns the real connection/hello attempt and maps its observed compatible, incompatible, refusal, and occupied outcomes through that capability.
- Removed the `config.ts` dynamic import of `client.ts` and the associated configuration-to-client cycle.

Files touched:

- `packages/music-core/session/config.ts`
- `packages/music-core/session/client.ts`

No commit, push, or `.apnea/state.json` edit was performed.

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
48 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
178 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n "Bun\\.spawn|child_process|spawn\\(" packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts
exit 0

$ jj diff --summary
exit 0
M packages/music-core/session/client.ts
M packages/music-core/session/config.ts
M packages/music-core/session/music-sessiond.ts
M packages/music-core/session/server.ts
M packages/music-core/tests/session-client.test.ts
M packages/music-core/tests/session-server.test.ts

$ git diff --check
exit 0
```

The focused and full runs emitted the existing intentional injected unlink-failure warning from `session-server.test.ts`; both exited successfully.

## Residual risks

- The remaining focused filesystem/process matrix expansion remains within the Phase 4 package for review.
- No production process launch, retry, reconnect, or idle-shutdown behavior was added.
