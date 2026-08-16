---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 5 package is aligned with the approved plan: it is confined to singleton auto-start, listener-first ownership, bounded startup scheduling, and version-skew policy, with the later reconnect/load/artwork/host work remaining out of scope.

## Findings

### Critical — Listener acquisition still occurs after coordinator/provider acquisition

`packages/music-core/session/server.ts:531-637` still requests `MusicSessionCoordinator` before creating and binding the listener. Neither `server.ts` nor `music-sessiond.ts` changed in this round. A bind-racing loser can therefore acquire provider/coordinator work before learning that it lost the socket, contrary to the central singleton-ownership requirement. Split out the listener service, compose the shared listener-first graph in both server entry points, and prove that a bind loser acquires no provider/event/coordinator ownership and cannot disturb the winner.

### High — Startup coordination is not the required Effect-scoped, bounded workflow

`packages/music-core/session/client.ts:658-727` uses a raw async `for` loop and runs a newly constructed one-step schedule only in the final branch. Marker acquisition contention, stale cleanup, acquisition, and spawn transitions consume attempts without the one paced retry schedule; there is no capped maximum delay or validated timing configuration; and there is no Effect workflow using scoped state/finalization. `finally { await lease?.release() }` also replaces a primary startup failure if release fails rather than preserving both outcomes. `MusicSessionStartupError` is a plain `Error`, not the required schema-tagged startup boundary. Implement one Effect-native workflow that retries only typed pending state through one bounded exponential/capped jittered schedule, validates its timing through config, installs lease release immediately as a scoped finalizer, and preserves primary plus release failures.

### High — Owned-marker authority is token-only and forgeable

`packages/music-core/session/client.ts:518-525` publicly accepts an arbitrary `ownedAttemptToken`, and `packages/music-core/session/config.ts:593-634` uses only that string when deciding which marker discovery may ignore. It does not require the lease's captured device/inode proof. A caller, or a replacement marker carrying a copied token, can therefore be treated as this attempt's exact owned marker. Keep this authority opaque and lease-backed so discovery can ignore only the exact marker identity acquired by that lease.

### High — Failed marker acquisition can remove a replacement or leak its own marker

On marker write/sync failure, `packages/music-core/session/config.ts:698-715` closes the handle and then unconditionally unlinks the path without revalidating the created inode or token. If the path was replaced in that interval, this removes another attempt's artifact. Conversely, close or post-write `lstat`/validation failures do not have failure-safe exact-owner cleanup. Acquisition failure cleanup must remain identity guarded, typed, and must not suppress cleanup diagnostics.

### High — Required concurrency, skew, launcher, and failure evidence is absent

The two added tests cover one 20-way marker acquisition race and one single-caller launch. They do not cover at least 20 concurrent `connectOrStart` callers converging on one listener/provider, the lower-level two-daemon bind race, schedule pacing/capping/interruption/timeout, exact production spawn options and spawn errors, or incompatibility before/after acquisition and while waiting. The coder result explicitly reports these residuals. Add the package-required deterministic real-socket and Effect scheduling evidence, including marker release on every terminal path and preservation of an existing incompatible generation and its healthy clients.

## Verification

The reported focused suite (67 passing) and full music-core run (197 passing, including build, typecheck, format, and package checks) are green, and product changes are within allowed Phase 5 paths. Passing regressions do not establish the unimplemented acceptance checks above.
