---
status: done
---

## Changed

- Restricted the legacy protocol schema to the only supported preceding wire shape: `{ major: 1, minor: 0 }`; arbitrary legacy major/minor values now fail decoding rather than being normalized into compatibility.
- Moved non-negative integer semantics into the shared `SafeInt` schema, covering request IDs, revisions, times, durations, ranges, and seek positions at decode time.
- Added an explicit-client real-socket negotiation test that verifies selected revision and deterministic capability exposure.

Files touched:

- `packages/music-core/session/protocol.ts`
- `packages/music-core/tests/session-client.test.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
33 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
155 pass, 0 fail
Verified npm package contents (21 files)
NX   Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ jj diff --summary
exit 0
M packages/music-core/session/client.ts
M packages/music-core/session/protocol.ts
M packages/music-core/session/server.ts
M packages/music-core/tests/session-client.test.ts
M packages/music-core/tests/session-protocol.test.ts
(existing phase artifact/state/task changes remain preserved)
```

## Residual risks

- Existing intentional multiple-cleanup-failure coverage continues to emit its expected warning in the full server suite.
- No commit, squash, push, or `.apnea/state.json` edit was performed.
