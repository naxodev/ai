---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package matches the approved plan, and the diff is confined to the allowed client, public-index, and client-test paths. No later idle/fan-out/artwork/host work entered the phase.

## Findings

### Critical — Terminal supervision is immediately overwritten as disposal

`ManagedMusicSessionClient.#finish` publishes the required retained terminal state at `packages/music-core/session/client.ts:1169-1173`, but every natural supervisor exit runs `managed.shutdown()` through `Effect.ensuring` at line 1249. `shutdown()` sets `#disposed`, publishes `disposed`, and clears every listener (`1175-1195`). Therefore replacement incompatibility, schedule exhaustion, unsafe/occupied startup, and non-retryable explicit-client errors are only momentarily terminal before becoming disposed; callers cannot inspect retained terminal details or subscribe after the transition. Reserve disposed semantics for caller/scope interruption and preserve terminal state when supervision stops naturally.

### High — Non-startup runtime/config failures lose their actionable structure

`asManagedTerminal` (`client.ts:970-981`) preserves only `MusicSessionClientError` and `MusicSessionStartupError`. Secure runtime and config failures returned by the reused startup workflow are converted to a generic non-retryable `CONNECTION_LOST`, dropping tagged operation/path/setting data. This does not meet the package requirement that occupied/unsafe/config terminal outcomes remain actionable. Preserve or truthfully wrap those structured boundary errors in the managed lifecycle contract.

### High — Most required reconnect race and terminal evidence is absent

The phase adds one explicit-terminal test and one successful real A→B integration test (`session-client.test.ts:663-772`). It does not provide the required deterministic evidence for:

- TestClock-paced replacement exhaustion/interruption and no busy loop;
- disposal while sleeping/connecting and disposal of a client that completes late;
- replacement incompatibility with exact range details and no later attempt;
- independently controlled late A state/status/terminal/response callbacks after B adoption;
- commands rejecting immediately during reconnect;
- retained status replay, listener unsubscription, and terminal lifecycle retention.

There is also no connector seam capable of driving the late-completion/generation races described by the package. These are Phase 4 acceptance requirements, not later-phase expansion.

## Verification

The coder supplied passing typecheck, focused, combined, full-target, timer-scan, runtime-artifact, and diff evidence (4 focused tests, 88 combined tests, 218 full tests). The focused count largely selects pre-existing indeterminate tests and does not cover the missing terminal/race matrix above.
