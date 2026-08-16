---
status: done
---

## Changed

- Added schema-owned `TransportResult` decoding and changed client transport methods to return it.
- Replaced loose pending callbacks with identity-bearing request entries and at-most-once settlement.
- Matched transport responses by request ID/action, ignore unsolicited responses, reject malformed/mismatched results as indeterminate, and preserve error details.
- Distinguished terminal future-call `CONNECTION_LOST` from in-flight `INDETERMINATE_COMMAND`, while disposal settles pending/future calls as `DISPOSED`.
- Added real-socket reverse-order concurrent response coverage and updated the blocked server regression to assert `INDETERMINATE_COMMAND`.

Files touched:

- `packages/music-core/session/client.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-server.test.ts
exit 0
41 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
163 pass, 0 fail
Verified npm package contents (21 files)
NX   Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n "setTimeout\\(|Bun\\.sleep|Date\\.now\\(|Effect\\.yieldNow" packages/music-core/tests/session-client.test.ts
exit 0

$ jj diff --summary
exit 0
M packages/music-core/session/client.ts
M packages/music-core/session/protocol.ts
M packages/music-core/tests/session-client.test.ts
M packages/music-core/tests/session-server.test.ts
(existing phase artifact/state/task changes remain preserved)
```

## Residual risks

- Existing cleanup-failure coverage logs its intentional injected unlink warning.
- No commit, squash, push, or `.apnea/state.json` edit was performed.
