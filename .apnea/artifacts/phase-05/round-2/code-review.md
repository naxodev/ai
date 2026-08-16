---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The assigned package is Phase 5 zero-client idle shutdown and remains aligned with the approved plan. The Round 1 review was also explicitly against this Phase 5 package; it did not request singleton/startup or Phase 1–3 rework.

## Findings

### Critical — The negotiated join/leave ownership race remains unchanged

No source changed in Round 2. A compatible hello still executes `yield* onJoin` before assigning `joined = true` in `packages/music-core/session/server.ts`. Interruption after the queue accepts the join but before the assignment causes the connection finalizer to skip `onLeave`, retaining a phantom negotiated-client count and preventing idle shutdown. Enrollment and the finalizer's leave obligation must be transferred interruption-safely, with deterministic immediate-disconnect evidence.

### High — The required Phase 5 acceptance matrix remains missing

Round 2 adds no tests. The only focused idle test still covers initial no-client expiry, not the package's required real-client lifecycle. Evidence remains absent for:

- grace cancellation/restart across one client, two clients, non-last departure, last departure, and rejoin;
- raw pre-hello, malformed, and incompatible sockets not pinning the daemon;
- exact selected-graph ordering/artifact cleanup and signal/idle/defect convergence;
- executable startup-loss status-zero idle exit and bounded cleanup;
- reconnect rejoining generation A before grace and adopting B after A exits;
- bounded structural diagnostics without playback payloads.

The Round 2 coder result itself acknowledges that the assigned Phase 5 gaps remain.

### High — The environment-backed idle-grace Config entry remains missing

`MusicSessionConfigLive` still exposes the other runtime timings but neither reads a matching idle-grace `Config` value nor passes it into `resolve`. Production therefore remains fixed to the default instead of receiving the package-required validated environment-backed setting. Focused invalid-value coverage is also incomplete.

### Medium — Round 2 verification is incomplete

The coder supplied typecheck, one focused idle test, `git diff --check`, and a diff summary only. The required combined client/server suite, uncached full build/typecheck/test/format/package matrix, and raw-timer scan were not reported for this round. More importantly, passing the single existing idle test cannot satisfy the missing acceptance evidence above.
