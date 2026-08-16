---
status: done
---

## What changed

Reworked the Pi packed-package smoke to derive and validate the exact Pi development pins and peer ranges from the music-dock manifest, then install the packed dock/core plus exact Pi packages into one temporary root with lifecycle scripts disabled. The smoke now resolves the manifest-selected isolated `pi` binary, verifies its exact version, runs the existing RPC registration scenario with isolated Pi state/offline mode, and confirms exact process-group termination before cleanup.

## Files touched

- `packages/pi-music-dock/scripts/package-smoke.ts`
- `.apnea/artifacts/phase-03/round-1/coder-result.md`

## Verification transcript

```text
$ bunx nx run pi-music-dock:smoke --skip-nx-cache
exit: 0
> nx run pi-music-dock:smoke
> bun run smoke:package
$ bun scripts/package-smoke.ts
installed Pi 0.84.0: /private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/pi-music-dock-smoke-OTw5Ue/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
isolated packed roots: music-dock=/private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/pi-music-dock-smoke-OTw5Ue/node_modules/@naxodev/pi-music-dock; music-core=/private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/pi-music-dock-smoke-OTw5Ue/node_modules/@naxodev/music-core
Pi registered extension commands: /music, /music-next, /music-prev
Pi RPC status-zero exit and cleanup: ok
NX Successfully ran target smoke for project pi-music-dock

$ ! find packages/pi-music-dock -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.log' -o -name '*.tmp' \) -print -quit | grep -q .
exit: 0
(no output; no prohibited package-directory artifacts found)

$ jj diff --summary
exit: 0
tail:
M .apnea/state.json
A .apnea/tasks/code-p3-r1-1786919360944.md
A .apnea/tasks/phase_package-p3-r1-1786919213963.md
M packages/pi-music-dock/scripts/package-smoke.ts

$ jj status
exit: 0
tail:
M .apnea/state.json
A .apnea/tasks/code-p3-r1-1786919360944.md
A .apnea/tasks/phase_package-p3-r1-1786919213963.md
M packages/pi-music-dock/scripts/package-smoke.ts
Working copy  (@) : vxrnmlov c87ba437 (no description set)
Parent commit (@-): ornnkvpk 6613d6d1 test(opencode): verify packed pinned plugin
```

## Residual risks

The machine-local smoke depends on Bun, npm, Node, and registry availability for the exact Pi pins. If exact process-group termination cannot be confirmed, cleanup fails and reports the retained unique smoke root rather than removing files beneath a potentially live Pi process. Existing unrelated `.apnea` changes, including `.apnea/state.json`, were preserved and not edited.
