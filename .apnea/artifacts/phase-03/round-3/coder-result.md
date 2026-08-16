---
status: done
---

## What changed

Added a non-destructive ownership observation for processes whose command line references the unique installed packed music-core root. The smoke records that no such process exists before Pi starts, requires none after the exact Pi process group exits, and repeats that check immediately before root removal. A detected daemon/provider-related process or failed process inspection fails cleanup and retains/reports the root; no broad process cleanup was added.

## Files touched

- `packages/pi-music-dock/scripts/package-smoke.ts`
- `.apnea/artifacts/phase-03/round-3/coder-result.md`

## Verification transcript

```text
$ bunx nx run pi-music-dock:smoke --skip-nx-cache
exit: 0
> nx run pi-music-dock:smoke
> bun run smoke:package
$ bun scripts/package-smoke.ts
installed Pi 0.84.0: /private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/pi-music-dock-smoke-Yf1jeG/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
isolated packed roots: music-dock=/private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/pi-music-dock-smoke-Yf1jeG/node_modules/@naxodev/pi-music-dock; music-core=/private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/pi-music-dock-smoke-Yf1jeG/node_modules/@naxodev/music-core
Pi registered extension commands: /music, /music-next, /music-prev
Pi RPC status-zero exit and cleanup: ok
NX Successfully ran target smoke for project pi-music-dock

$ ! find packages/pi-music-dock -type f \( -name '*.tgz' -o -name '*.sock' -o -name '*.log' -o -name '*.tmp' \) -print -quit | grep -q .
exit: 0
(no output; no prohibited package-directory artifacts found)

$ jj diff --summary
exit: 0
tail:
A .apnea/tasks/code_review-p3-r1-1786919592976.md
A .apnea/tasks/code_review-p3-r2-1786919768483.md
A .apnea/tasks/phase_package-p3-r1-1786919213963.md
M packages/pi-music-dock/scripts/package-smoke.ts

$ jj status
exit: 0
tail:
A .apnea/tasks/code_review-p3-r1-1786919592976.md
A .apnea/tasks/code_review-p3-r2-1786919768483.md
A .apnea/tasks/phase_package-p3-r1-1786919213963.md
M packages/pi-music-dock/scripts/package-smoke.ts
Working copy  (@) : vxrnmlov d216c99e (no description set)
Parent commit (@-): ornnkvpk 6613d6d1 test(opencode): verify packed pinned plugin
```

## Residual risks

The smoke depends on macOS `/bin/ps`, Bun, npm, Node, and registry availability for the exact Pi pins. It only observes processes tied to its unique installed core path and never performs broad process cleanup; an unconfirmed owned process causes root retention rather than unsafe deletion. Existing unrelated `.apnea` changes, including `.apnea/state.json`, were preserved and not edited.
