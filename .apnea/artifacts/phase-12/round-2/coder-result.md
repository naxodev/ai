---
status: done
---

## Changed

- Removed the unintended core root configuration exports; the package surface remains unchanged.
- Replaced the Bun-bundled lifecycle program with a temporary Node ESM loader. Node now loads the installed package by name through its installed module graph; the temporary loader transpiles only installed core `.ts` sources and uses the temporary install's TypeScript helper.
- Added bounded verifier/harness command, startup, disposal, daemon-exit, signal, and exact-child cleanup ownership.
- Added the manifest-selected invalid `--idle-grace-ms 0` daemon invocation, asserting status 1, Effect-config diagnostic, and no retained runtime artifacts.
- Isolated daemon provider discovery with an owned empty temporary PATH and checked negotiated revisions against installed `PROTOCOL` bounds.
- Moved idle-grace value validation to the existing Effect config boundary; CLI parsing now only supplies the numeric argument.

Files touched:

- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/scripts/verify-pack.ts`
- `packages/music-core/session/music-sessiond.ts`

## Verification

```text
$ bunx nx run music-core:smoke --skip-nx-cache
exit 0
installed Node v24.8.0
installed package root: /private/tmp/music-core-installed-smoke-…/install/node_modules/@naxodev/music-core/index.ts
manifest daemon: /private/tmp/music-core-installed-smoke-…/install/node_modules/@naxodev/music-core/dist/music-sessiond.js
negotiated daemon: music-session-…
status-zero idle exit and cleanup: ok

$ bunx nx run music-core:package:check --skip-nx-cache
exit 0
Verified npm package contents (21 files)

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core --skip-nx-cache
initial run hit the existing concurrent-managed-callers test flake; immediate isolated rerun passed:
$ bunx nx run music-core:test --skip-nx-cache
exit 0
music-core: 261 pass, 0 fail

$ ! find packages/music-core -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.bind-lock*' -o -name '*.log' -o -name '*.tmp' \) -print -quit | grep -q .
exit 0

$ git diff --check && jj diff --summary && jj status
exit 0
```

## Residual risks

- Node currently rejects native TypeScript stripping within `node_modules`; the smoke uses a temporary Node loader and temporary TypeScript dev helper, while Node directly resolves and executes the installed package/module graph (not a Bun bundle).
- OpenCode and Pi installed-package smokes remain deferred to Phases 13–14.
- Existing dirty `.apnea/state.json` was not edited.
