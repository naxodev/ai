---
status: done
verdict: CHANGES_REQUIRED
---

# Findings

## High: The package drops the approved end-to-end snapshot acceptance check

The approved plan requires a paused or changed playback snapshot to reach `session.player` while earlier artwork work remains unresolved (`.apnea/artifacts/plan.md:106`). The phase package weakens this to reaching only the facade playback subscriber (`.apnea/artifacts/phase-02/round-1/phase-package.md:139`) and explicitly defers direct controller snapshot handling to phase 3 (`.apnea/artifacts/phase-02/round-1/phase-package.md:111`). This is material package drift, so the package must be corrected before approval.

The implementation exhibits the missing behavior. The controller discards every core event payload and calls `requestRefresh()` (`packages/opencode-music-player/index.tsx:338`). If `player()` is delayed, an authoritative paused or changed snapshot cannot update `session.player` immediately. Consume snapshot payloads synchronously in this phase, while retaining invalidation-triggered refresh behavior.

## Medium: The tests do not exercise the required producer-to-controller slice

The facade test stops after asserting that a projected snapshot reaches a facade listener (`packages/opencode-music-player/tests/system-media.test.ts:277-297`). The controller test injects an artwork completion directly into a fake backend after initial sampling (`packages/opencode-music-player/tests/controller.test.ts:189-213`). No regression leaves artwork unresolved, sends a real facade snapshot through the controller, and proves that both playback and later artwork completion update `session.player` without another provider call. Add the end-to-end regression required by the approved plan (`.apnea/artifacts/plan.md:102-107`).
