---
status: done
verdict: APPROVED
---

## Package comparison

The Phase 3 package remains aligned with the approved plan: it is confined to foreground socket-server and connection ownership, preserves the current protocol, and does not require later protocol, lifecycle-discovery, load, or host evidence.

## Review

The remaining gates are resolved:

- The shutdown-only hook invokes the production acceptance callback after the real server state is marked closing and before listener close. The focused test proves that exact socket is synchronously destroyed without acceptance, enrollment, or connection finalization.
- The executable subprocess test starts the real Layer graph, delivers `SIGTERM`, induces a real non-`ENOENT` unlink failure, and proves nonzero exit status plus tagged `MusicSession.SocketError`/`unlink` diagnostics. It also confirms the listener has closed despite the retained socket artifact. Existing direct-Layer and blocked-sampling tests provide the corresponding dependency-order and exact-finalization evidence.
- The older focused socket/error tests now use failure-safe cleanup, including clients, raw sockets, server facades, Effect scopes, subprocesses, permissions, and temporary paths.

The accumulated implementation continues to provide one scoped graph, supervised connection/input/forwarding work, deterministic acceptance-shutdown behavior, local connection-failure isolation, ordered and observable cleanup, typed failure propagation, and memoized repeated close.

## Verification

The coder reports 25 server tests, 65 coordinator/provider tests, all five `music-core` targets, required static scans, and `jj diff --summary` passing. I independently ran the focused server suite (25 pass, 0 fail) and all required static scans successfully. Worktree inspection confines product changes to the allowed Phase 3 server, executable, and test files; `.apnea/state.json` remains an unrelated pre-existing modification.
