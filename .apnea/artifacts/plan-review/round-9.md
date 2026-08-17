---
status: done
verdict: CHANGES_REQUIRED
---

## Findings

### Critical — Final owned-pane disappearance is still not enforced

The final harness still uses:

```sh
! herdr pane get "$oc_pane" >/dev/null 2>&1
! herdr pane get "$pi_pane" >/dev/null 2>&1
```

As noted in the prior review, Bash exempts shell-negated commands from `set -e`. If either pane still exists, `herdr pane get` succeeds, `!` returns failure, and execution nevertheless continues to the successful certification message. Replace both with explicit predicates such as `if herdr pane get ...; then exit 1; fi` so pane persistence is a real gate.

### Critical — Recovery can press Enter without actually proving the OpenCode Exit row is selected

Recovery calls `select_oc_palette_action` as an `if` condition. Bash suppresses `errexit` throughout a function used as a conditional, but `select_oc_palette_action` still relies on bare command failures for `send-keys`, `wait-output`, `capture_ui`, query `grep`, and the Bun ANSI-selection assertion. Any of those can fail and fall through to the final successful `printf`, causing the function to return success; recovery then sends Enter despite not proving the selected `System / Exit the app` row.

Make every operation and assertion in `select_oc_palette_action` explicitly propagate failure with `|| return 1`, including the Bun selected-row validation and final UI capture. Recovery must never submit Enter unless all palette-opening, query, and selected-row evidence steps succeeded.

### High — Recovery's recorded-PID assertion is not conditional-safe

`assert_recorded_pids_gone` uses bare `test` commands in a loop and is invoked in an `&&` condition during recovery. A surviving earlier PID can be masked by a later absent PID because `errexit` is suppressed in that context. Parse the PID set with an explicitly checked `jq` command and return failure immediately for each PID that still exists, so ownership flags cannot be cleared unless every recorded PID is proven absent.
