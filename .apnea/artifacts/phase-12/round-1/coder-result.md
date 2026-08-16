---
status: done
---

## Changed

- Added `--installed-smoke` mode to the existing core package verifier while preserving its default exact dry-pack allowlist behavior.
- The smoke builds and packs core into a unique `/tmp` root, installs only the tarball as the application dependency, resolves the installed root/bin from its manifest, bundles a temporary installed-package harness, and executes that harness with a validated absolute Node executable.
- The Node lifecycle harness uses the installed public reconnecting client/config API and manifest-selected daemon, asserts real managed startup/hello/status/state replay, awaits client disposal and zero-client idle exit, verifies diagnostics and exact runtime-artifact cleanup, and removes all temporary ownership on success or failure.
- Added the narrowly validated `--idle-grace-ms` daemon option; absence retains the existing production default.
- Added `music-core:smoke` / `smoke:package` wiring. The root now exports the existing runtime-path resolver/types required by the public installed-client configuration path.

Files touched:

- `packages/music-core/index.ts`
- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/music-core/scripts/verify-pack.ts`
- `packages/music-core/session/music-sessiond.ts`

## Verification

```text
$ bunx nx run music-core:package:check --skip-nx-cache
exit 0
Verified npm package contents (21 files)

$ bunx nx run music-core:smoke --skip-nx-cache
exit 0
installed Node v24.8.0
installed package root: /private/tmp/music-core-installed-smoke-…/install/node_modules/@naxodev/music-core/index.ts
manifest daemon: /private/tmp/music-core-installed-smoke-…/install/node_modules/@naxodev/music-core/dist/music-sessiond.js
negotiated daemon: music-session-…
status-zero idle exit and cleanup: ok

$ bunx nx run-many -t build typecheck test format:check package:check --projects=music-core --skip-nx-cache
exit 0
NX Successfully ran targets build, typecheck, test, format:check, package:check for project music-core
music-core: 261 pass, 0 fail

$ ! find packages/music-core -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.bind-lock*' -o -name '*.log' -o -name '*.tmp' \) -print -quit | grep -q .
exit 0

$ git diff --check && jj diff --summary && jj status
exit 0
No retained core smoke artifacts; existing .apnea state/task/artifact dirt remains untouched.
```

## Residual risks

- The temporary Node harness is bundled from the installed package because Node refuses native TypeScript stripping for `node_modules`; the executed client code and daemon are still resolved from the installed tarball, and the lifecycle process is Node.
- OpenCode and Pi installed-package smokes remain intentionally deferred to Phases 13–14.
- Existing dirty `.apnea/state.json` was not edited.
