---
status: done
---

## Changed

- Added coordinator-scoped in-flight artwork ownership keyed by full identity. Equal requests join the same `Deferred`; distinct misses are admitted against the finite cache/in-flight budget; failed, stale, and interrupted work is removed before return.
- Hardened native artwork decoding: missing native IDs are stale, non-object JSON is unavailable, and bounded base64 is canonicalized after size validation.
- Required nonempty artwork provider IDs at the protocol boundary.
- Added server-side response-size fallback from an oversized artwork response to correlated `too-large`.

Files touched:

- `packages/music-core/session/coordinator.ts`
- `packages/music-core/session/protocol.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/system-media.ts`

## Verification

```text
$ bun test packages/music-core/tests/system-media.test.ts packages/music-core/tests/session-protocol.test.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-coordinator.test.ts
exit 0 — 185 pass, 0 fail

$ bunx tsc -p packages/music-core/tsconfig.json --noEmit
exit 0

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0 — 242 pass, 0 fail; build, typecheck, format, and package checks passed

$ git diff --check
exit 0
```

## Residual risks

- The phase’s requested artwork-specific system-media/protocol/coordinator/server test matrix and fake-provider artwork controls remain absent; only the existing baseline suites were run.
- The existing configuration derives a conservative effective artwork byte limit for small frames rather than rejecting every impossible `maxFrameBytes`/artwork-limit combination.
- `.apnea/state.json` was not edited.
