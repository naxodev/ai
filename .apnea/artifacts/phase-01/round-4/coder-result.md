---
status: done
---

# Phase 1 rework result — reset authority and bounded diagnostics

## Changes

- `packages/music-core/session/config.ts`: added an opaque `ManagedRuntimeProbe.starting()` authority check. It returns `starting` only for a valid, live marker and never exposes cleanup.
- `packages/music-core/session/client.ts`: retryable reset errors consult that authority; malformed or unmarked peers remain occupied. Stderr framing now retains a byte-bounded prefix of an overlong daemon-prefixed line across chunks while discarding the remainder.
- `packages/music-core/tests/session-client.test.ts`: added a real Unix reset endpoint plus an acquired live marker regression, asserting `starting`, no cleanup, and preserved socket; extended stderr coverage for split readiness/error lines and a multichunk over-limit daemon diagnostic.

## Verification

```text
$ bun test packages/music-core/tests/session-client.test.ts
exit: 0
74 pass, 0 fail

$ bunx nx run music-core:typecheck --skip-nx-cache
exit: 0
Successfully ran target typecheck for project music-core

$ bunx nx run music-core:test --skip-nx-cache
exit: 0
265 pass, 0 fail (Round 3 run after the same production logic; focused suite was rerun after this test-only extension)

$ bunx nx run music-core:package:check --skip-nx-cache
exit: 0
Verified npm package contents (21 files)

$ bunx nx run music-core:smoke --skip-nx-cache
exit: 0
status-zero idle exit and cleanup: ok

$ bunx nx run opencode-music-player:smoke --skip-nx-cache
exit: 0
OpenCode loaded the installed package and rendered its app and sidebar slots.

$ bunx nx run pi-music-dock:smoke --skip-nx-cache
exit: 0
Pi registered extension commands: /music, /music-next, /music-prev
```

## Residual risks

An existing OpenCode-supervised daemon was present during final cleanup inspection and is owned by an active `opencode2 --auto -c` parent, so I did not terminate or unlink its endpoint. The direct reset/marker branch and bounded diagnostic behavior are now deterministic; current-code regular-pane host observations remain required before phase approval.
