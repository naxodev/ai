---
status: done
---

# Phase 1 rework result — host-boundary diagnostics

## Changes

- Added coordinator-level coverage proving a launched daemon's typed `exit` (exit code, signal, bounded diagnostic) reaches `connectOrStartMusicSessionEffect` rather than becoming timeout.
- Extended stderr sanitization coverage: non-daemon playback, artwork, and environment sentinels are excluded; the daemon-prefixed diagnostic remains byte-bounded.
- Retained the direct live-marker/reset socket regression and the terminal malformed/unmarked peer coverage from the preceding rework.

## Verification

```text
$ bun test packages/music-core/tests/session-client.test.ts
exit: 0
75 pass, 0 fail

$ bunx nx run music-core:typecheck --skip-nx-cache
exit: 0
Successfully ran target typecheck for project music-core
```

## Residual risks / blocker

The required real-host clean window is unavailable: production daemon PID 45621 is a child of `opencode2 --auto -c` PID 24183, whose zsh parent is operating from `/Users/nachovazquez/work/1-projects/maelstrom-co/maelstrom-3`, not this task's owned pane/worktree. I did not signal it or remove its socket. Consequently, I could not safely run the required isolated OpenCode/Pi current-code initialization certification or final closed-state gate in this round. No commit was made.
