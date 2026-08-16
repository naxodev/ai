---
status: done
---

## What changed

Updated the workspace overview, three package READMEs, and architecture field guide to document the current same-user machine-local music-session daemon. The docs now distinguish client presentation from daemon-owned provider, polling, replay, global transport, native artwork, bounded work, generation/reconnect, idle-exit, and exact-owned cleanup responsibilities. OpenCode references `0.0.0-next-17386`; Pi retains its 0.83.x/0.84.x support range and identifies the exact 0.84.0 smoke pin.

## Files touched

- `README.md`
- `packages/music-core/README.md`
- `packages/opencode-music-player/README.md`
- `packages/pi-music-dock/README.md`
- `docs/music-session-architecture.html`
- `.apnea/artifacts/phase-04/round-1/coder-result.md`

## Verification transcript

```text
$ bunx prettier --check README.md packages/music-core/README.md packages/opencode-music-player/README.md packages/pi-music-dock/README.md docs/music-session-architecture.html
exit: 0
Checking formatting...
All matched files use Prettier code style!

$ ! rg -n 'Direct / current|Broker / scale path|future broker|when coordination is required' docs/music-session-architecture.html packages/music-core/README.md packages/opencode-music-player/README.md packages/pi-music-dock/README.md
exit: 0
(no output)

$ ! rg -n '0\.0\.0-next-17041' README.md packages/opencode-music-player/README.md docs/music-session-architecture.html
exit: 0
(no output)

$ jj diff --summary
exit: 0
tail:
M README.md
M docs/music-session-architecture.html
M packages/music-core/README.md
M packages/opencode-music-player/README.md
M packages/pi-music-dock/README.md

$ jj status
exit: 0
tail:
M README.md
M docs/music-session-architecture.html
M packages/music-core/README.md
M packages/opencode-music-player/README.md
M packages/pi-music-dock/README.md
Working copy  (@) : sqxwqytv 53036b7a (no description set)
Parent commit (@-): vxrnmlov dee247d7 test(pi): verify packed music extension
```

## Residual risks

These documentation checks validate formatting and remove the specified stale wording; they do not replace later full-repository or mixed-host verification. Existing unrelated `.apnea` changes, including `.apnea/state.json`, were preserved and not edited.
