---
status: done
verdict: CHANGES_REQUIRED
---

# Findings

## Medium: Cache eviction can start duplicate artwork jobs for one recording

The corrected package requires at most one artwork job per complete recording identity while preserving the 32-entry cache bound (`.apnea/artifacts/phase-02/round-1/phase-package.md:48`, `.apnea/artifacts/phase-02/round-1/phase-package.md:147`). The cache evicts its oldest entry whenever a 33rd identity is inserted, even when that entry still has a pending detached job (`packages/opencode-music-player/system-media.ts:144-159`). A later request for the evicted recording creates a new entry and starts a second concurrent job while the first remains active (`packages/opencode-music-player/system-media.ts:162-194`). Keep in-flight work deduplicated independently from settled-cache eviction, and add deterministic coverage that crosses the cache boundary with the oldest job unresolved.

The focused held-refresh correction closes the latest prior finding: the controller test leaves the initial `player()` sample unresolved, applies the stream snapshot synchronously, completes artwork without another sample, and resolves the held sample only after disposal (`packages/opencode-music-player/tests/controller.test.ts:196-284`). The coder result also includes passing evidence for the package verify command.
