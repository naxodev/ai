---
status: done
---

## Changed

- Made disposed session adapters fully inert: state and presentation subscriptions return inert idempotent disposers without replaying state, creating artwork work, or retaining listeners.
- Added active-owner fencing to shared artwork jobs. A released session generation cannot mutate the cache or publish a late completion; a replacement host detects the inactive owner and starts its own request.
- Added adapter/controller disposal coverage for retained state/status/connection callbacks, held command completion, queued command suppression, exact client unsubscription order, and exact-once client release.
- Added coverage for post-disposal operations, same-metadata replacement artwork, and cache/presentation protection against a late released generation.

Files touched:

- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/tests/system-media.test.ts`
- `packages/opencode-music-player/tests/controller-lifecycle.test.ts`

## Verification

```text
$ bun --cwd packages/opencode-music-player test --preload @opentui/solid/preload tests/system-media.test.ts tests/controller.test.ts tests/controller-lifecycle.test.ts tests/artwork-lifecycle.test.ts
exit 0 — focused adapter/controller lifecycle suite passed.

$ bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player
exit 0 — all targets passed; music-core 259 pass, opencode-music-player 162 pass.

$ jj diff --summary
exit 0 — inspected accumulated dirty baseline and phase paths.

$ jj diff --git <phase-08 allowed files>
exit 0 — inspected 1379-line exact phase diff.

$ git diff --check
exit 0

$ rg -n 'createBackend: createSystemMedia|createSessionSystemMedia|media-control.*get.*--now' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
exit 0 — production remains direct; only the direct adapter uses media-control get --now.
```

## Residual risks

- Production selection intentionally remains `createSystemMedia` until Phase 9.
- Existing unrelated dirty `.apnea/state.json` was not edited.
