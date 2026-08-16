---
status: done
---

## Changed

- Added idle-specific managed reconnect evidence: A idles out before B is launched/adopted, while a reconnect before A's grace remains on A.
- Added foreground convergence coverage for signal and server-defect paths; an observed defect prevents idle from winning.
- Added deterministic post-join disconnect coverage using an atomic-transfer observation hook.
- Expanded idle cleanup and executable assertions for exact finalization counts, provider ownership, listener/signal cleanup, reservation artifacts, and bounded diagnostics.
- Stabilized the existing protocol test with its intended fake provider, avoiding machine playback-event fan-out.

## Files touched

- `packages/music-core/session/config.ts`
- `packages/music-core/session/server.ts`
- `packages/music-core/session/music-sessiond.ts`
- `packages/music-core/tests/session-client.test.ts`
- `packages/music-core/tests/session-server.test.ts`
- `.apnea/artifacts/phase-05/round-7/coder-result.md`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts -t 'idle|last client|grace'
exit 0
7 pass, 0 fail

$ bun test packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts
exit 0
104 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
234 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts packages/music-core/session/client.ts
exit 0

$ jj diff --git packages/music-core/session/config.ts packages/music-core/session/server.ts packages/music-core/session/music-sessiond.ts packages/music-core/session/client.ts packages/music-core/tests/session-server.test.ts packages/music-core/tests/session-client.test.ts
exit 0
inspected (1000 lines)

$ git diff --check
exit 0
```

The full matrix emits expected injected cleanup-failure warnings from existing fixtures.

## Residual risks

- The last negotiated connection necessarily finalizes before it starts the grace; the selected graph then finalizes coordinator, provider, listener, and unlink owners once. Existing blocked-work shutdown coverage continues to prove coordinator-before-active-connection teardown.
- Pre-existing unrelated `.apnea` and state changes remain untouched. No commit, push, or `.apnea/state.json` edit was performed.
