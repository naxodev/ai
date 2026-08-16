---
status: done
---

## Changed

- Completed schema-level cross-field validation for protocol ranges, selected revisions, capability error details, seek/non-seek transport payloads, and contradictory response payloads.
- Added the shared Effect request decoder and used it in the server’s Effect connection path; stable protocol-error mapping remains at that boundary.
- Added focused schema tests for semantic constraints, additive evolution, and required replay capability.
- Added real Unix-socket coverage for legacy/current shared replay and live updates, incompatible-peer isolation, state-only transport rejection before admission, and client teardown after an impossible hello result.

Files touched:

- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/tests/session-protocol.test.ts`
- `packages/music-core/tests/session-server.test.ts`
- `packages/music-core/tests/session-client.test.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
37 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
159 pass, 0 fail
Verified npm package contents (21 files)
NX   Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ jj diff --summary
exit 0
M packages/music-core/session/client.ts
M packages/music-core/session/protocol.ts
M packages/music-core/session/server.ts
M packages/music-core/tests/session-client.test.ts
M packages/music-core/tests/session-protocol.test.ts
M packages/music-core/tests/session-server.test.ts
(existing phase artifact/state/task changes remain preserved)
```

## Residual risks

- The full server suite intentionally logs the existing injected unlink failure during multiple-cleanup-failure coverage.
- No commit, squash, push, or `.apnea/state.json` edit was performed.
