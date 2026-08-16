---
status: done
---

## Changed

Implemented the Phase 3 managed-startup acceptance work.

- Added a narrow dependency/observation seam to `connectOrStartMusicSessionEffect`; production adapters retain production discovery, lease acquisition, and launcher behavior.
- Kept all pending startup transitions under the bounded Effect retry schedule, and made exact owned-marker release uninterruptible and one-shot. Release failures are synchronously observable, logged without sensitive marker data, preserve a primary failure, and turn an otherwise successful startup into a failure after disposing its client.
- Treated a temporary pre-hardening socket as pending only when a valid live startup marker authorizes it, allowing concurrent managed callers to converge without weakening unsafe-artifact rejection.
- Added TestClock pacing/interruption coverage, real 20-client managed convergence, marker timeout/interruption/release-failure coverage, and incompatibility coverage before acquisition, after acquisition, and while waiting on a foreign marker. Healthy supported clients perform live commands after each incompatibility case.

## Files touched

- `packages/music-core/session/config.ts`
- `packages/music-core/session/client.ts`
- `packages/music-core/tests/session-client.test.ts`
- `.apnea/artifacts/phase-03/round-1/coder-result.md`

## Verify transcript

```text
$ bun test packages/music-core/tests/session-client.test.ts -t 'TestClock|20 concurrent|marker.*release|incompatib'
exit 0
8 pass, 0 fail

$ bun test packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
81 pass, 0 fail

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core
exit 0
211 pass, 0 fail
Verified npm package contents (21 files)
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core

$ ! rg -n 'setTimeout\(|setInterval\(|Bun\.sleep' packages/music-core/session/config.ts packages/music-core/session/client.ts
exit 0

$ jj diff --summary
exit 0
M packages/music-core/session/config.ts
M packages/music-core/session/client.ts
M packages/music-core/tests/session-client.test.ts
(existing unrelated phase metadata/state/task changes remain outside this implementation)

$ jj diff --git packages/music-core/session/config.ts packages/music-core/session/client.ts packages/music-core/tests/session-client.test.ts packages/music-core/tests/session-server.test.ts
exit 0
Only config.ts, client.ts, and session-client.test.ts changed among inspected Phase 3 paths.

$ git diff --check
exit 0
```

## Residual risks

- The release-failure test intentionally emits the bounded marker-release warning; the pre-existing server cleanup test also emits its expected tagged unlink warning.
- No commit, push, or `.apnea/state.json` edit was performed.
