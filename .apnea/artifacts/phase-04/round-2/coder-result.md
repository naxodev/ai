---
status: done
---

## Rework completed

Addressed every finding from the Phase 4 review.

- Natural reconnect-supervisor termination now retains `terminal` lifecycle state and its listeners instead of running managed disposal. Caller/scope disposal still closes resources, but does not overwrite a prior actionable terminal outcome.
- Managed terminal errors now preserve `MusicSessionRuntimeError` and `MusicSessionConfigError` alongside startup/protocol errors, retaining their tagged operation/path/setting data.
- Added a client-module-only connector seam to drive deterministic scoped generation races; it is not exported from the public core index.
- Registered each successfully connected explicit client as a scoped resource before wrapper adoption, so scoped cleanup owns completed generations across disposal/adoption handoff.
- Added deterministic coverage for replacement incompatibility (including retained exact ranges and no loop), runtime terminal preservation, TestClock cancellation of a reconnect sleep, and the bounded Phase 3 replacement schedule/no busy loop.
- Expanded real A→B selected-server coverage: commands reject immediately during reconnect, retained A state replays to a reconnect-time subscriber, and idempotent unsubscription prevents B replay delivery.

## Files touched

- `packages/music-core/session/client.ts`
- `packages/music-core/tests/session-client.test.ts`
- `.apnea/artifacts/phase-04/round-2/coder-result.md`

`packages/music-core/index.ts` remains the prior Phase 4 public-surface change and was not modified in this rework. No server/config/protocol changes were needed.

## Verify transcript

```text
$ bunx nx run music-core:typecheck
exit 0
NX Successfully ran target typecheck for project music-core

$ bun test packages/music-core/tests/session-client.test.ts -t 'reconnect|replacement generation|indeterminate'
exit 0
7 pass, 0 fail
39 expect() calls

$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
92 pass, 0 fail
515 expect() calls

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
222 pass, 0 fail
930 expect() calls
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/client.ts
exit 0

$ jj diff --summary
exit 0
Phase source diff remains limited to music-core index/client/client-test paths. Existing unrelated .apnea metadata/tasks and .apnea/state.json remain dirty and untouched.

$ jj diff --git packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/session/protocol.ts packages/music-core/index.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0

$ git diff --check
exit 0
```

## Residual risks

- The client/server suite emits pre-existing intentional injected cleanup and marker-release warnings; commands exit successfully.
- No commit, push, or `.apnea/state.json` edit was performed.
