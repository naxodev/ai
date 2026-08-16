---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package matches the approved plan. Changes are confined to the allowed config/client/client-test paths and do not add reconnect, idle, fan-out, host, packaging, or documentation work.

## Findings

### High — The required TestClock schedule matrix is incomplete

`packages/music-core/tests/session-client.test.ts:60-146` proves an immediate attempt, a coarse no-early-attempt bound, one capped interval, and an interruption, but it never scripts success before exhaustion or proves that success causes no extra attempt. The TestClock exhaustion path only checks `Exit.isFailure`, not the typed `MusicSessionStartupError { operation: "timeout" }`, and the recorded timings do not establish the required exponential progression. The interruption case also does not synchronize that its own first attempt occurred and entered scheduled sleep before interruption. Add deterministic production-schedule evidence for success, exact typed exhaustion, progression/cap, and interruption while sleeping.

### High — Marker finalization coverage omits required workflow exits and truthful dual failures

The new tests cover success, timeout, interruption, and a release-only failure, but there is no complete `connectOrStart` launcher rejection test proving one spawn and marker release. There is also no primary-failure-plus-release-failure case proving the spawn/timeout error remains primary while the release error is observed separately, nor a workflow-level replacement-marker case. The release-only test at `session-client.test.ts:641-672` does not establish that the successfully handshaken client was disposed when release failed. These are explicit Phase 3 acceptance checks, not lease-level baseline coverage.

### High — Skew and single-generation evidence remains materially incomplete

The incompatibility tests create their supported client only after the incompatible workflow has already failed, so they do not prove an already-supported client remains live through the race. The after-acquisition and waiting cases also capture socket identity only after the terminal outcome, and the waiting case does not count probes before/after advancing beyond the schedule; therefore they cannot prove no retry/replacement occurred during the race. Range details are asserted only in the before-acquisition case. Finally, no test closes a server returned by `connectOrStart` and proves that this returned client performs no relaunch/reconnect. Complete the three race-position assertions and the required one-generation live-loss check.

### Medium — The 20-caller failure path can leak late clients and does not inspect bind debris

The convergence test uses fail-fast `Promise.all` (`session-client.test.ts:582-608`). If one caller rejects, other startup calls continue after `finally` begins and can return clients after the current `clients` array has been disposed and the server/runtime removed. Await all callers to settlement before cleanup. The success path also checks socket and marker removal but not the bind lock or temporary bind-reservation names required by the package.

## Verification

The coder supplied passing focused, combined, and full `music-core` verification (8 focused tests, 81 client/server tests, and 211 full tests), plus the timer scan and diff checks. Those green runs do not cover the acceptance gaps above.
