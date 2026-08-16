---
status: done
---

## Changed

- Combined retained provider-status and connection lifecycle into one precedence-aware adapter message: reconnect/terminal errors win over ready status, while degraded status survives a connected transition.
- Removed duplicate install replay emissions, centralized factory-failure observation, assigned each default adapter a distinct stable client ID, and made repeated adapter disposal return one shared completion Promise.
- Prevented cached adapter `player()` polls and successful controls from clearing lifecycle-owned controller errors; replacement connection lifecycle explicitly clears them.
- Added adapter-backed controller coverage for A → reconnecting → lower-revision B state, retained reconnect feedback across cached polling, plus lifecycle precedence coverage.

Files touched:

- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/tests/system-media.test.ts`
- `packages/opencode-music-player/tests/controller.test.ts`

## Verification

```text
$ bun test packages/opencode-music-player/tests/system-media.test.ts packages/opencode-music-player/tests/controller.test.ts packages/opencode-music-player/tests/controller-lifecycle.test.ts packages/opencode-music-player/tests/artwork-lifecycle.test.ts
exit 0 — 56 pass, 0 fail

$ bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player
exit 0 — all targets passed; music-core 259 pass, opencode-music-player 155 pass

$ jj diff --summary
exit 0 — inspected phase paths and pre-existing dirty baseline

$ git diff --check
exit 0

$ rg -n 'createBackend: createSystemMedia|createSessionSystemMedia|media-control.*get.*--now' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
exit 0 — default remains direct; only the direct adapter contains `media-control get --now`
```

## Residual risks

- Additional adapter artwork outcome/late-completion and active-client disposal race coverage remains for review.
- Production selection intentionally remains `createSystemMedia` until Phase 9.
- `.apnea/state.json` was not edited.
