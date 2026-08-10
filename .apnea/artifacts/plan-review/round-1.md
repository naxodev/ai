---
status: done
verdict: CHANGES_REQUIRED
---

## Findings

### High: Phase 2 is not a vertical slice and can leave artwork completion unconsumed

Phase 2 changes artwork resolution into a separate presentation event and requires completion to update without another provider poll (`plan.md:94-108`). The controller does not consume that event until Phase 3 (`plan.md:147-160`). Therefore, Phase 2 cannot demonstrate the requested presentation update through the product, and the intermediate stack may stop completed artwork from reaching the UI. Move the identity-checked controller projection and its end-to-end acceptance test into Phase 2, or preserve the existing artwork delivery path until the consuming controller change lands in the same phase.

### Medium: Pi transport intent handling remains an unresolved conditional

Phase 4 says to replace Pi's busy latch only if the richer event flow exposes the race, and its acceptance check applies only "if that path is exercised" (`plan.md:203-215`). The plan must determine whether Pi currently drops repeated intents during delayed work and then state a definite implementation and deterministic regression, or explicitly establish why Pi is outside the transport-intent requirement. A conditional implementation decision does not provide an executable phase scope or a binary acceptance result.

### Medium: Disposal promise settlement has no defined observable contract

Phase 3 requires disposal to settle queued controller promises without executing commands (`plan.md:151-161`), but it does not define whether superseded seek intents and disposed queued intents resolve, reject, or return a cancellation result. Specify the settlement behavior, including the in-flight intent, and encode it in acceptance checks. Otherwise implementations can satisfy "settle" with incompatible caller-visible behavior while lifecycle tests assert different assumptions.
