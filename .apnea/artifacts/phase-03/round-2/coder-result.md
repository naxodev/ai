---
status: done
---

## What changed

Addressed both Phase 3 review findings in the packed Pi smoke. Failed process-group termination now captures available stdout/stderr only under a one-second bound before entering outer cleanup; an ultimately unconfirmed group fails and retains/reports the unique root. The smoke also reads the installed packed dock's peer ranges and checks both exact installed Pi versions against them, while preserving the source-manifest pin/range checks.

## Files touched

- `packages/pi-music-dock/scripts/package-smoke.ts`
- `.apnea/artifacts/phase-03/round-2/coder-result.md`

## Verification transcript

```text
$ bunx nx run pi-music-dock:smoke --skip-nx-cache
exit: 0
> nx run pi-music-dock:smoke
> bun run smoke:package
$ bun scripts/package-smoke.ts
installed Pi 0.84.0: /private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/pi-music-dock-smoke-tFtTD3/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
isolated packed roots: music-dock=/private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/pi-music-dock-smoke-tFtTD3/node_modules/@naxodev/pi-music-dock; music-core=/private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/pi-music-dock-smoke-tFtTD3/node_modules/@naxodev/music-core
Pi registered extension commands: /music, /music-next, /music-prev
Pi RPC status-zero exit and cleanup: ok
NX Successfully ran target smoke for project pi-music-dock

$ ! find packages/pi-music-dock -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.log' -o -name '*.tmp' \) -print -quit | grep -q .
exit: 0
(no output; no prohibited package-directory artifacts found)

$ jj diff --summary
exit: 0
tail:
A .apnea/tasks/code-p3-r2-1786919682384.md
A .apnea/tasks/code_review-p3-r1-1786919592976.md
A .apnea/tasks/phase_package-p3-r1-1786919213963.md
M packages/pi-music-dock/scripts/package-smoke.ts

$ jj status
exit: 0
tail:
A .apnea/tasks/code-p3-r2-1786919682384.md
A .apnea/tasks/code_review-p3-r1-1786919592976.md
A .apnea/tasks/phase_package-p3-r1-1786919213963.md
M packages/pi-music-dock/scripts/package-smoke.ts
Working copy  (@) : vxrnmlov e094dac1 (no description set)
Parent commit (@-): ornnkvpk 6613d6d1 test(opencode): verify packed pinned plugin
```

## Residual risks

The machine-local smoke depends on Bun, npm, Node, and registry availability for the exact Pi pins. Failure-path process termination is bounded; if the exact group still cannot be confirmed dead, the smoke retains/reports its root rather than deleting beneath a possibly live process. Existing unrelated `.apnea` changes, including `.apnea/state.json`, were preserved and not edited.
