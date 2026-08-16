---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 7 package remains aligned with the approved plan. Round 13 uses only allowed tests and closes native command compatibility coverage, but reconnect fencing and the remaining coordinator/server races still fail the acceptance gate.

## Findings

### High — Reconnecting artwork still has no generation fence

`ReconnectingMusicSessionClient.artwork()` directly returns `active.client.artwork(identity)` (`packages/music-core/session/client.ts:1372-1377`). It captures neither the active generation nor wrapper disposal state, so a client-like generation whose artwork Promise resolves after generation B is adopted can still resolve the caller with generation A's stale result.

The new test does not exercise that race: `scriptedGeneration.terminal()` rejects and removes every artwork resolver before `first.respondArtwork(...)` is called. The later response is therefore a no-op, not a late completion being fenced. Add wrapper-level generation/disposal fencing and test with generation A's Promise deliberately left pending across terminal/B adoption, then resolved late. The original call must settle truthfully once and the late result must be ignored; no artwork call may be replayed to B.

### High — Coordinator cancellation/finalization and distinct in-flight capacity remain unproved

Round 13 adds no coordinator coverage. Required tests are still missing for admission/start interruption, first-caller interruption with a surviving equal-key joiner, coordinator-scope shutdown of a blocked provider read, exact waiter settlement/entry removal/finalization ordering, and bounded rejection/recovery when distinct in-flight keys fill capacity.

Add interruption/finalization observations to the Effect-native fixture and force each race under bounded cleanup. These paths previously contained ownerless-entry defects and cannot be inferred from normal success tests.

### High — Real selected-server blocked-read and final-response containment remain absent

There is still no real multi-client socket test proving one shared provider call for equal requests, state and another client's command progress during a blocked read, post-read stale discard, one client's disconnect isolation, or provider failure followed by retry. Stable unavailable/malformed/too-large wire outcomes and the final oversized-response fallback also remain untested.

Add selected-server tests that cover mandatory-lane correlation at the exact payload boundary and prove an unexpected oversized result becomes correlated `too-large` without closing or disrupting the connection.

## Verification

Round 13 reports eight focused artwork tests, a green 253-test Nx build/typecheck/test/format/package matrix, `git diff --check`, and a clean forbidden-boundary scan. Existing and newly added coverage is green; the verdict is based on the implementation/test gaps above.

## Resolved findings

Native adapter tests now distinguish timeout from ordinary command failure and prove ordinary sampling and stream commands retain `--no-artwork`, while the dedicated native read alone uses `media-control get --now`. The reconnect test does establish one initial delegation, `CONNECTION_LOST` settlement for the scripted generation, and no replay to generation B; it does not establish late-completion fencing.
