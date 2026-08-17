---
status: done
verdict: CHANGES_REQUIRED
---

## Findings

### Critical — Recovery still can submit Enter without a proven OpenCode Exit selection

The prior finding remains unresolved. `select_oc_palette_action` still uses bare commands for every operation and assertion (`send-keys`, `wait-output`, `send-text`, `capture_ui`, query `grep`, and the Bun ANSI check). Recovery invokes this function as an `if` condition, which suppresses `errexit` throughout the function. A failed palette operation or selected-row assertion can therefore fall through to the final successful `printf`; recovery then sends Enter even though `System / Exit the app` was not proven selected.

Add explicit `|| return 1` propagation to every command and assertion in `select_oc_palette_action`, including sleeps where relevant, UI capture, query presence, Bun selected-row validation, and evidence output. Enter must only be sent after the function returns success from the complete proof sequence.

### High — Recovery can still clear ownership without proving every recorded PID is gone

The prior `assert_recorded_pids_gone` issue also remains. It uses bare `test` commands in a loop and is called in an `&&` condition during recovery. In that context, a surviving earlier PID can be masked by a later absent PID; a failed `jq` process substitution can also yield an empty loop and success. This violates the acceptance requirement that every recorded PID be absent before ownership flags are cleared.

Explicitly validate the `jq` result, require a nonempty recorded PID set, and return failure immediately for any PID that still exists. Do not rely on `set -e` inside a helper used by conditional recovery logic.
