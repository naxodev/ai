---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 8 package remains aligned with the approved plan. Round 6 stays within allowed adapter/test paths, production remains direct, and the shared-cache regression is fixed. The phase still lacks the controller/artwork/fake acceptance required to leave a fully tested selectable adapter.

## Findings

### High — Adapter-backed controller behavior remains materially incomplete

No controller test changed in Round 6. The session adapter/controller composition still does not prove:

- live playing, paused, and idle projection with waveform fields;
- successful loading and optimistic play/pause/seek;
- failed-command toast/loading behavior through the adapter;
- local seek coalescing without an adapter queue/replay;
- degraded/unavailable and terminal lifecycle feedback in the controller store;
- observer exception isolation;
- authoritative artwork completion merging only for the full current identity.

Use a deterministic public-contract fake with held controls and artwork through `createSessionSystemMedia`. Existing generic controller tests and adapter-unit delegation tests do not satisfy the package's explicit composition gate.

### High — Session artwork ownership is still not proved through the controller/artwork lifecycle

`artwork-lifecycle.test.ts` remains unchanged. Facade-level cache tests now cover A/B ownership internally, but there is no package-required controller/presentation test where old session native work and a held resolver complete after a new full provider identity/generation becomes current. The evidence must prove the old completion cannot merge, clean up, or overwrite the newer presentation owner and that B's completion remains authoritative.

Add that assertion through the existing controller artwork merge/ownership path, including disposal and both held native and resolver completion timing.

### High — Active disposal coverage still omits held artwork/reconnect and retained callback races

The controller lifecycle suite covers a held play and queued command, but not held artwork, reconnect completion, or retained state/status/connection callback references invoked after unsubscription. It also does not call controller disposal repeatedly in the installed-adapter case while checking exact-once release/caller settlement. Complete these deterministic cases and prove no late store, toast, timer, next-command, or presentation work occurs.

### Medium — The public-contract fake/adapter matrix remains incomplete

The shared fake still lacks factory acquisition failure, held command controls, held native artwork across generation/disposal, disposed lifecycle emission, and exact failure replay for early and late subscribers. Multiple artwork tests use `setTimeout(0)` instead of sentinels and do not guarantee held-work settlement in `finally` if an assertion fails. Add the controls specified by the package and use deterministic cleanup.

## Resolved findings

Round 6 correctly narrows disposal cleanup: pending and null-result retry entries owned by A are removed/reset, while successful shared artwork is preserved and its worker ownership is cleared. The new overlapping test proves B retains A's successful metadata-cache hit after A disposes and performs no replacement native request. The abandoned-job and exhausted-retry-budget fixes from Round 5 remain intact.

## Verification

The package-cwd focused suite passes, and the Nx matrix reports 259 music-core plus 164 OpenCode tests with typecheck, format, and package checks green. Diff and selector inspections are clean. The exact root preload command remains unavailable in this checkout; its package-cwd equivalent passed. The verdict is based on the package acceptance matrix still absent above.
