---
status: done
---

## What changed

- Made the migration-owned package smoke diagnostics type-safe under the repository TypeScript configuration:
  - `packages/opencode-music-player/scripts/package-smoke.ts` handles absent synchronous child output.
  - `packages/pi-music-dock/scripts/package-smoke.ts` validates piped RPC streams inside the existing termination/cleanup path and handles absent synchronous child output.
- Corrected the machine-local global `@opencode-ai/cli` installation outside the repository from `0.0.0-beta-17498` to the required `0.0.0-next-17386`; no repository manifest or lockfile changed.

## Files touched

- `packages/opencode-music-player/scripts/package-smoke.ts`
- `packages/pi-music-dock/scripts/package-smoke.ts`
- `.apnea/artifacts/phase-05/round-4/coder-result.md`

## Verification transcript

```text
$ bunx nx run opencode-music-player:typecheck --skip-nx-cache
exit: 0
NX Successfully ran target typecheck for project opencode-music-player

$ bunx nx run pi-music-dock:typecheck --skip-nx-cache
exit: 0
NX Successfully ran target typecheck for project pi-music-dock

$ bunx nx run opencode-music-player:smoke --skip-nx-cache
exit: 0
installed OpenCode 0.0.0-next-17386: .../node_modules/@opencode-ai/cli/bin/opencode2.exe
isolated packed resolutions: plugin=.../@naxodev/opencode-music-player/index.tsx; core=.../@naxodev/music-core/index.ts
OpenCode loaded the installed package and rendered its app and sidebar slots.
OpenCode package smoke cleanup: ok

$ bunx nx run pi-music-dock:smoke --skip-nx-cache
exit: 0
installed Pi 0.84.0: .../node_modules/@earendil-works/pi-coding-agent/dist/cli.js
isolated packed roots: music-dock=.../@naxodev/pi-music-dock; music-core=.../@naxodev/music-core
Pi registered extension commands: /music, /music-next, /music-prev
Pi RPC status-zero exit and cleanup: ok

$ bun add --global @opencode-ai/cli@0.0.0-next-17386 && opencode2 --version
exit: 0
installed @opencode-ai/cli@0.0.0-next-17386 with binaries:
 - opencode2
opencode2 v0.0.0-next-17386

$ bun run check
exit: 0
root format:check: passed
root policy:check: passed (8 pass, 0 fail)
NX Successfully ran targets typecheck, test, parity, format:check, package:check, smoke for 6 projects
Nx read the output from the cache instead of running the command for 29 out of 31 tasks.

Final gate smoke evidence:
installed Node v24.8.0
installed package root: /private/tmp/music-core-installed-smoke-l2aubf/install/node_modules/@naxodev/music-core/index.ts
manifest daemon: /private/tmp/music-core-installed-smoke-l2aubf/install/node_modules/@naxodev/music-core/dist/music-sessiond.js
negotiated daemon: music-session-8x4247qym2f revision 1
status-zero idle exit and cleanup: ok
installed OpenCode 0.0.0-next-17386: .../node_modules/@opencode-ai/cli/bin/opencode2.exe
OpenCode loaded the installed package and rendered its app and sidebar slots.
OpenCode package smoke cleanup: ok
installed Pi 0.84.0: .../node_modules/@earendil-works/pi-coding-agent/dist/cli.js
Pi registered extension commands: /music, /music-next, /music-prev
Pi RPC status-zero exit and cleanup: ok
OpenCode loaded the installed package and rendered its Vim footer.

$ git diff --check
exit: 0
(no output)

$ jj diff --summary
exit: 0
tail:
M .apnea/tasks/code_review-p9-r4-1786913898082.md
A .apnea/tasks/phase_package-p5-r1-1786920567592.md
M packages/opencode-music-player/scripts/package-smoke.ts
M packages/pi-music-dock/scripts/package-smoke.ts

$ jj status
exit: 0
tail:
A .apnea/tasks/phase_package-p5-r1-1786920567592.md
M packages/opencode-music-player/scripts/package-smoke.ts
M packages/pi-music-dock/scripts/package-smoke.ts
Working copy  (@) : omxssoxq d17152b3 (no description set)
Parent commit (@-): sqxwqytv ae742b68 docs(music): document shared session architecture
```

## Residual risks

The initial root-policy attempt had a single five-second timeout in the coordinated release fixture; its focused rerun passed, as did the subsequent full gate. Nx reported `opencode-vim:smoke` as historically flaky, but the final exact-pinned run passed. The full gate uses configured cache entries where valid. No interactive mixed-host verification was performed, no repository runtime debris was reported, and `.apnea/state.json` was not edited.
