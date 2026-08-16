---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package remains aligned with the approved plan, and the round-2 source delta is confined to the allowed client test file.

## Findings

### Critical — The primary/release-failure test launches and leaks the real detached daemon

`packages/music-core/tests/session-client.test.ts:899-910` scripts perpetual `missing` discovery but does not provide a launcher. On its second attempt, the authoritative workflow therefore calls the production `launchManagedMusicSessionDaemon`, which ignores the test runtime and starts the packed daemon at the real managed default. The test then reaches its expected timeout and its `finally` only removes the temporary custom root; it has no child handle and cannot stop the detached daemon.

This leak is present after the claimed verification: PID `25627` is still running `packages/music-core/dist/music-sessiond.js`, and `/tmp/naxodev-music-$(id -u)/s.sock` remains live. Besides violating unconditional cleanup and phase isolation, an already-running leaked daemon can make later repetitions appear green by causing subsequent detached children to lose bind and exit. Inject a bounded/no-op test launcher (and assert its invocation as appropriate) so the test exercises timeout plus release failure without crossing the real process boundary; ensure the leaked runtime/process is accounted for before rerunning verification.

## Verification

The coder reported 12 focused tests, 85 combined tests, and 215 full `music-core` tests passing, plus typecheck, timer scan, and diff checks. Those results are not sufficient while the test leaves a detached daemon and real runtime socket behind.
