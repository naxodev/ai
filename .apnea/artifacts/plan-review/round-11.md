---
status: done
verdict: CHANGES_REQUIRED
---

## Findings

### Critical — Recovery can probe generation after the protected socket tuple has changed

`capture_recovery_state` independently runs:

```sh
recovery_probe "$label.endpoint" assert_endpoint
recovery_probe "$label.generation" direct_generation
```

`direct_generation` validates the current endpoint before connecting, but it does not compare that tuple with `baseline_socket`; it only checks that the tuple remains stable during its own call. If the socket is replaced while retaining the expected path/owner/mode and daemon PID/command, recovery will connect a generation probe even though the protected baseline tuple mismatched. The same issue exists if recovery runs before a baseline tuple was successfully established.

A protected tuple mismatch must be a blocker before any probe. Capture the endpoint result/status, compare it to a nonempty `baseline_socket`, and only then invoke `direct_generation`; otherwise record generation as skipped. Prefer also passing the expected tuple into `direct_generation` so the pre-connect comparison is enforced inside the probing primitive.

### High — UI capture can pass even when zooming to the required viewport failed

`capture_ui` does not guard its initial `herdr pane zoom --on` call or include that status in `rc`. Both `assert_ui` and recovery palette selection invoke `capture_ui` in conditional contexts, so `errexit` is suppressed. A zoom failure can therefore be ignored while reads succeed, allowing evidence from the split viewport to be treated as the required wide/coherent UI capture.

Handle the initial zoom status explicitly and return failure from certification assertions unless zoom-on, both reads, and zoom-off all succeed. Best-effort recovery may log individual failures, but selected-row and host-UI acceptance checks must not pass without the requested viewport state.
