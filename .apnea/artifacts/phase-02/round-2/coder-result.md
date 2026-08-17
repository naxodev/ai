---
status: done
---

# Phase 2 coder result

## Result: live certification blocked by the exact isolated OpenCode host

No product source, history, configuration, global host configuration, or `.apnea/state.json` was edited. The live run reached the exact isolated OpenCode launch, where its rendered UI reported **`⊙ 1 plugin failed`**. Per the package's fail-closed requirements, Pi was not launched and no playback control, reload, or further host action was attempted.

## History and operator prerequisites — PASS

```text
$ [self-contained Phase 2 source/history assertion]
exit 0
approved=bd952919 fix(music): tolerate daemon hello reset window parent=c78b5b93
M packages/music-core/session/client.ts
M packages/music-core/session/config.ts
M packages/music-core/tests/session-client.test.ts

$ test "${HERDR_ENV:-}" = 1; …; bunx --package @earendil-works/pi-coding-agent@0.84.0 pi --version | grep -qx '0.84.0'; …
exit 0
HERDR_ENV=1
Pi version: 0.84.0
media provider command present
/Users/nachovazquez/work/1-projects/naxodev/ai/packages/opencode-music-player
/Users/nachovazquez/work/1-projects/naxodev/ai/packages/pi-music-dock
```

## Owned regular Herdr resources

Caller: workspace `w2`, tab `w2:t4`, pane `w2:pET` (not controlled or closed).

Created only regular, returned resources in a new background tab:

```text
herdr tab create … --label 'music mixed certification' --no-focus
=> tab w2:tE; initial pane w2:pEV

owned panes created/used:
- w2:pEV — initial music inspector (closed unexpectedly when its fail-closed shell exited)
- w2:pEW — exact OpenCode
- w2:pEX — exact Pi (never launched)
- w2:pEY — replacement inspector (closed unexpectedly when its fail-closed shell exited)
- w2:pEZ — final persistent music inspector
```

The owned layout was regular (no floating panes). The final inspector layout had 78×71 cells, with OpenCode, Pi, and inspector panes; OpenCode was temporarily zoomed only to obtain an untruncated ANSI UI observation. After cleanup, only the owned tab was closed:

```text
$ herdr tab close w2:tE
exit 0
```

## Protected daemon baseline and checkpoints — PASS

The persistent owned inspector made the specified direct `createMusicSessionClient` probe against the validated explicit socket. It never used discovery or a daemon-starting API.

```text
2026-08-17T02:10:00Z baseline
PID:             45621
exact command:   node /Users/nachovazquez/work/1-projects/naxodev/ai/packages/music-core/dist/music-sessiond.js
socket:          /tmp/naxodev-music-501/s.sock
socket tuple:    16777231:1237478212:501:600
runtime directory: 501:700
generation:      music-session-zqg8kksdwec
endpoint/generation/endpoint checks: 0,0,0

COMMAND   PID         USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    45621 nachovazquez   13u  unix 0x92b42519e692921f      0t0      /tmp/naxodev-music-501/s.sock
node    45621 nachovazquez   16u  unix 0x91c6be82950a6663      0t0      /tmp/naxodev-music-501/s.sock
node    45621 nachovazquez   17u  unix 0xf243e941e197f75c      0t0      /tmp/naxodev-music-501/s.sock
node    45621 nachovazquez   18u  unix 0xea134277ddbd5d07      0t0      /tmp/naxodev-music-501/s.sock

2026-08-17T02:10:00Z pre-OpenCode checkpoint: attachment=0,0,0
2026-08-17T02:10:47Z post-OpenCode-launch checkpoint: attachment=0,0,0
2026-08-17T02:12:01Z post-owned-OpenCode-exit checkpoint: attachment=0,0,0
final lsof equality with baseline: 0
```

Thus the protected PID, command, socket device/inode/owner/mode, runtime-directory owner/mode, daemon generation, and original socket rows remained unchanged throughout the owned host attempt.

## Exact isolated OpenCode launch — BLOCKED

The exact prescribed install/config block ran in owned pane `w2:pEW`:

```text
$ (cd "$oc_root" && bun install)
exit 0
bun install v1.3.7
+ @opencode-ai/cli@0.0.0-next-17386
2 packages installed [4.94s]

oc_root=/private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/opencode-next-17386.pgW38D
oc_bin=/private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/opencode-next-17386.pgW38D/node_modules/@opencode-ai/cli/bin/opencode2.exe
oc_bin --version: opencode2 v0.0.0-next-17386
config=/private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/opencode-next-17386.pgW38D/config/cli.json
plugin=/Users/nachovazquez/work/1-projects/naxodev/ai/packages/opencode-music-player
```

The binary was contained below the ownership-validated temporary install's `node_modules` boundary. It was launched only with the prescribed isolated environment (`OPENCODE_CONFIG_DIR`, project config disabled, autoupdate disabled, models fetch disabled) and the checkout plugin. Process evidence:

```text
pane: w2:pEW
PID: 33380
argv: /private/var/folders/fh/zx6t2vf55zd3rmf08mrg5jdc0000gn/T/opencode-next-17386.pgW38D/node_modules/@opencode-ai/cli/bin/opencode2.exe --standalone --log-level error /Users/nachovazquez/work/1-projects/naxodev/ai
```

The ANSI-visible, zoomed OpenCode UI did render exact version `0.0.0-next-17386`, but its bottom status line was:

```text
⊙ 1 plugin failed                                      0.0.0-next-17386
```

No music compact/sidebar marker, title, artist, track identity, or play/pause state was rendered. That is direct live UI failure evidence, not a truncation claim. It violates the package requirement that there be no plugin-resolution/startup failure, so no simultaneous Pi launch or controls were safe to perform.

I submitted one normal terminal `ctrl+c` input to the owned OpenCode pane; no process was signaled directly. PID `33380` was gone afterwards. The shell hosting the prescribed `set -eu` block also exited rather than returning to a prompt, so its EXIT trap did not remove the root. I then ran the package's ownership checks verbatim against the known direct child root, confirmed the exact OpenCode PID was absent, and removed only that validated owned root:

```text
$ [ownership-validated cleanup_oc equivalent]
exit 0
owned_opencode_exited=1 oc_root_removed=1
```

Pi `0.84.0`, Pi profile creation, Pi launch, shared-state observation, bidirectional controls, `/reload`, Pi exit isolation, and post-Pi OpenCode controls were deliberately not executed: the required first host was visibly unhealthy.

## Final repository assertion — PASS

```text
$ [self-contained final repository assertion from the package]
exit 0
git diff --check: pass
bd952919 remains an ancestor; parent is c78b5b93
bd952919 summary is exactly the approved three product paths
working-copy child has no non-Apnea diff
```

## Residual risk / required rework

The isolated exact OpenCode host reports `1 plugin failed` despite using the prescribed exact CLI, isolated config, and absolute checkout plugin path. This environment/runtime failure blocks every remaining Phase 2 acceptance item. No daemon, socket, marker, unrelated client, or global configuration was changed, and no final idle-shutdown claim is made.
