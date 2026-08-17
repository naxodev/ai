---
status: done
verdict: CHANGES_REQUIRED
---

## Findings

### Critical — Recovery generation probing is still not gated by the baseline socket tuple

The prior finding remains unresolved. `capture_recovery_state` still invokes:

```sh
recovery_probe "$label.endpoint" assert_endpoint
recovery_probe "$label.generation" direct_generation
```

as independent probes. `direct_generation` verifies only that the current endpoint is internally valid and stable during that call; it never compares its pre-connect tuple to `baseline_socket`. Recovery can therefore connect after the protected socket inode/tuple has changed, or before a baseline tuple was established, despite tuple mismatch being a blocker.

Materialize the endpoint result and status, require a nonempty baseline tuple and exact equality before invoking generation probing, and otherwise record generation as skipped. The safest interface is for `direct_generation` itself to require the expected tuple and compare it immediately before connecting.

### High — UI capture still ignores zoom-on failure

The prior viewport finding also remains unresolved. `capture_ui` still executes the initial:

```sh
herdr pane zoom --pane "$pane" --on >/dev/null
```

without recording its status. Because callers invoke `capture_ui` through conditional `|| return` paths, Bash suppresses `errexit` inside the function. A failed zoom-on can be ignored while both reads and zoom-off succeed, allowing a split-pane capture to pass as the required wide/coherent UI or palette evidence.

Record zoom-on failure in `rc` (or return immediately after a best-effort zoom-off), and require zoom-on, both reads, and zoom-off to succeed for host UI and selected-row acceptance.
