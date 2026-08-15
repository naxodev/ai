---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 1 package remains aligned with the approved plan, and the product diff is confined to its three allowed files. The executable runner and real-listener closing-refusal changes address the first two narrow boundaries without reopening baseline server behavior.

## Findings

### High — The required whole-file failure-safety audit is still incomplete

Acceptance check 3 requires every focused server test to release resources when setup or an assertion fails, but several unchanged paths still bypass cleanup:

- `connected()` rejects on a socket `error` without destroying that socket, so callers cannot clean up a handle when connection setup fails.
- `scoped signal wait removes both handlers after a signal` starts a waiting Effect before assertions but has no `finally`; a failed listener-count assertion leaves the signal fiber/listeners active. The interruption variant manually creates a `Scope`, then performs assertions before `Scope.close` without an ensuring/finally path.
- `two clients share the daemon command lane` acquires the server and both clients before entering `try`. If either client acquisition fails, the `finally` block is never reached; `Promise.all` also makes a successfully acquired sibling client unavailable for disposal.
- `one graph replays hello, status, and state to both clients` likewise assigns neither client until `Promise.all` fully succeeds, contrary to the package's explicit requirement to retain each handle immediately.

The new closing-refusal test also waits only on the refusal latch and installs no client `error` rejection path. An unexpected connection failure can leave the test waiting forever instead of entering `finally` to release the closing gate.

Move these acquisitions under outer `try` blocks, retain each handle as soon as it is created, ensure manually created signal scopes/fibers are always interrupted, and make failed socket connection attempts destroy/reject through an awaitable path. This is mechanical test ownership work already required by the package, not expanded lifecycle acceptance.

## Verification

The coder reports both focused tests, all 25 server tests, 65 baseline tests, all music-core package targets, and the static scan passing. That supports the executable and closing-refusal behavior, but successful runs do not establish cleanup when setup or assertions fail; the finding above therefore remains blocking.
