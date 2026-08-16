---
status: done
---

## Changed

- Replaced the protocol’s parallel record/player validation with schema-owned wire schemas and schema-derived TypeScript types for requests, events, responses, state, errors, capabilities, legacy protocol, ranges, and negotiated results.
- Added legacy `1.0` mapping, current inclusive revision ranges, deterministic capability intersection, highest-overlap selection, and structured actionable incompatibility details.
- Updated server connections to retain negotiated session state, encode legacy/current hello results appropriately, isolate incompatible peers, and reject transport when it was not negotiated.
- Updated explicit clients to advertise a revision range/capabilities, validate negotiated hello results, and expose `selectedRevision`.
- Added protocol coverage for legacy/current negotiation, unknown capability tolerance, highest overlap, structured incompatibility, and malformed ranges.

Files touched:

- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/tests/session-protocol.test.ts`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
32 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
154 pass, 0 fail
Verified npm package contents (21 files)
NX   Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ jj diff --summary
exit 0
M packages/music-core/session/client.ts
M packages/music-core/session/protocol.ts
M packages/music-core/session/server.ts
M packages/music-core/tests/session-protocol.test.ts
(existing phase-package/state/task changes remain preserved)
```

## Residual risks

- The existing focused server suite’s expected multi-cleanup-failure warning remains unchanged.
- No commit, squash, push, or `.apnea/state.json` edit was performed.
