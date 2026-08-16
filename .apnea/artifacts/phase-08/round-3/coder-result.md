---
status: done
---

## Changed

- Replaced controller lifecycle/transport booleans with explicit error ownership so a connected lifecycle transition clears only lifecycle-owned feedback, never a later transport failure.
- Retained and deduplicated effective session lifecycle projection; late adapter subscribers now receive one retained snapshot and lifecycle replay with listener isolation.
- Made rejected/disconnected native artwork fall through to the existing host-local catalog resolver rather than caching an error; disposal removes interests and suppresses late presentation publication.
- Extended the public-contract fake and adapter coverage for replay deduplication, late observers, exact unsubscribe/disposal, bounded artwork outcomes and rejection fallback, same-Promise disposal, late resolver suppression, adapter-backed command-error ordering, and controller disposal before client acquisition.

Files touched:

- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/tests/system-media.test.ts`
- `packages/opencode-music-player/tests/controller.test.ts`
- `packages/opencode-music-player/tests/controller-lifecycle.test.ts`

## Verification

```text
$ bun test --preload @opentui/solid/preload packages/opencode-music-player/tests/system-media.test.ts packages/opencode-music-player/tests/controller.test.ts packages/opencode-music-player/tests/controller-lifecycle.test.ts packages/opencode-music-player/tests/artwork-lifecycle.test.ts
exit 1 — repository-root Bun could not resolve @opentui/solid/preload.

$ bun --cwd packages/opencode-music-player test --preload @opentui/solid/preload tests/system-media.test.ts tests/controller.test.ts tests/controller-lifecycle.test.ts tests/artwork-lifecycle.test.ts
exit 0 — 60 pass, 0 fail.

$ bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player
exit 0 — all targets passed; music-core 259 pass, opencode-music-player 159 pass.

$ jj diff --summary
exit 0 — inspected accumulated dirty baseline and phase paths.

$ jj diff --git <phase-08 allowed files>
exit 0 — inspected 1083-line exact phase diff.

$ git diff --check
exit 0

$ rg -n 'createBackend: createSystemMedia|createSessionSystemMedia|media-control.*get.*--now' packages/opencode-music-player/index.tsx packages/opencode-music-player/system-media.ts
exit 0 — production still uses direct createSystemMedia; only direct legacy adapter contains media-control get --now.
```

## Residual risks

- Production adapter selection remains intentionally deferred to Phase 9.
- Existing unrelated dirty `.apnea/state.json` was not edited.
