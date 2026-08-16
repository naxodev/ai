---
status: done
---

## Changed

- Replaced OpenCode's generic provider-derived `MusicBackend` with the narrow `SessionMedia` controller contract: session snapshot/lifecycle subscriptions, artwork presentation subscription, transport delegation, player projection, and asynchronous disposal only.
- Removed obsolete controller/backend selection naming, optional direct-provider compatibility fields, timer/delay seams, transport-kind parameter, and direct-sample presentation merging while retaining the bounded latest-seek coalescer and all authority/disposal behavior.
- Updated OpenCode adapter tests and deferred smoke fixture to the final session-media seam; removed only presentation-merging tests for obsolete direct samples.
- Added root public-API type/runtime coverage for the reconnecting client, protocol, state, and status surface while retaining the intentional `createSystemMedia()` compatibility API.
- Tightened core package verification to assert the root export and reject every unexpected packed entry.
- Changed both host runtime dependencies to `@naxodev/music-core: ^0.1.0`; regenerated the lock metadata to retain the publishable range while resolving the local workspace package.

Files touched:

- `bun.lock`
- `packages/music-core/scripts/verify-pack.ts`
- `packages/music-core/tests/public-api.test.ts`
- `packages/opencode-music-player/{index.tsx,package.json,system-media.ts,types.ts}`
- `packages/opencode-music-player/scripts/package-smoke.ts`
- `packages/opencode-music-player/tests/{types,system-media,controller,controller-lifecycle,package-load}.test.ts`
- `packages/pi-music-dock/package.json`

## Verification

```text
$ bun test packages/music-core/tests/public-api.test.ts
exit 0
2 pass, 0 fail

$ bun test --preload @opentui/solid/preload packages/opencode-music-player/tests/types.test.ts packages/opencode-music-player/tests/system-media.test.ts packages/opencode-music-player/tests/controller.test.ts packages/opencode-music-player/tests/controller-lifecycle.test.ts packages/opencode-music-player/tests/package-load.test.ts
exit 0
33 pass, 0 fail

$ bun test packages/pi-music-dock/test/index.test.ts
exit 0
10 pass, 0 fail

$ bunx nx run-many -t typecheck test format:check package:check --projects=music-core,opencode-music-player,pi-music-dock
exit 0
NX Successfully ran targets typecheck, test, format:check, package:check for 3 projects
music-core: 261 pass, 0 fail
opencode-music-player: 126 pass, 0 fail
pi-music-dock: 23 pass, 0 fail

$ (cd packages/music-core && npm pack --dry-run --json --ignore-scripts >/dev/null)
exit 0

$ forbidden OpenCode/Pi ownership and compatibility-symbol scans
exit 0

$ ! rg -n '"@naxodev/music-core": "workspace:' packages/opencode-music-player/package.json packages/pi-music-dock/package.json bun.lock
exit 0

$ host pin assertion; unexpected-package-artifact scan; git diff --check
exit 0
```

## Residual risks

- Installed-package daemon and exact-host OpenCode/Pi lifecycle smokes remain intentionally deferred to Phases 12–14.
- Existing dirty `.apnea/state.json` was not edited.
