# Artifacts

## Layout

```text
.apnea/                          # runtime; ignore in VCS
  config.json                    # optional project role→profile bindings only
  state.json                     # step, phase index, rounds, required rework target, slug
  tasks/
    <dispatch-id>.md             # human/agent-readable task payload
  artifacts/
    plan.md                      # or plan-round-N.md on plan rework
    plan-review/
      round-1.md
    phase-01/
      round-1/
        phase-package.md
        coder-result.md
        code-review.md
        verify.log               # written by workflow_commit_phase
    phase-02/
      ...
    pr-description.md
```

Package-owned briefs live in the installed package (`briefs/`), not under `.apnea/`.

## Front-matter schema

Required on every role-produced artifact:

| Field    | Values                  |
| -------- | ----------------------- |
| `status` | `done` (v1; no partial) |

Review artifacts also require:

| Field     | Values                           |
| --------- | -------------------------------- |
| `verdict` | `APPROVED` \| `CHANGES_REQUIRED` |

Code-review artifacts with `CHANGES_REQUIRED` may also declare:

| Field    | Values                    |
| -------- | ------------------------- |
| `rework` | `code` \| `phase_package` |

Missing `rework` means `code`, preserving existing review artifacts. `phase_package` returns the run to phase packaging. The revised package is written under the next `round-N` directory, so the rejected package and review remain available.

Optional:

| Field  | Values                                           |
| ------ | ------------------------------------------------ |
| `nits` | freeform markdown string; ignored by commit gate |

Non-review artifacts (plan, phase package, coder result, pr-description): `status: done` only; no `verdict`.

## Clear-before-dispatch

For a given target path, `dispatch_role` deletes or renames away any existing file at that path before sending the pointer so absence means “not done.”

On rework after CHANGES_REQUIRED, the **round number increases** and the path changes (`round-2/...`), so history is preserved.

On crash redelivery, `dispatch_role` requires `redeliver=true`, matching pending ownership, and proof that any recorded pane is dead. It clears and reuses the same path without advancing the round. Manual/no-Herdr ownership requires an explicit operator request because no pane can provide liveness evidence.

`state.json.pending_delivery` records whether pending ownership crossed a `manual` or `interactive` delivery boundary. Dispatch persists `interactive` before calling `runInteractivePrompt`, even though `pending_pane_id` is still null. This closes the crash window where the prompt may be accepted but the pane id cannot be saved: redelivery refuses that ambiguous state. Completion clears the mode with every other pending field, and rollback restores the prior mode.

Version-1 state lacks this mode. A recorded pending pane safely migrates to `interactive`; a null pane cannot distinguish manual work from an accepted interactive prompt whose final save failed. It migrates to null and redelivery fails closed instead of guessing.

Before checking pane liveness or renaming the artifact, redelivery reads the pending path and applies the complete `workflow_wait` acceptance boundary: completeness, rework legality, frontmatter schema decoding, and state transition. An accepted artifact refuses redelivery with an explicit `workflow_wait` next step and remains unchanged. Review `status: done` without a valid verdict is incomplete. Illegal or unknown rework metadata is malformed. Both proceed to normal redelivery validation.

## Persisted rework ownership

After a review rejects work, `state.json.required_rework` names the exact next target: `plan`, `code`, or `phase_package`. Dispatch consumes this marker only when it saves pending ownership. Refusals and launch rollback preserve it. A recovered same-round dispatch sees a cleared marker and does not advance the round again.

Version-1 state without this field migrates package rework only from `phase_package_rework: true`. Planning state and coding state with `current_code_review` are ambiguous: either may be initial work after a completed prior stage. Only an explicit, matching deprecated assertion (`kind=plan` or `kind=code` with `rework=true`) converts that legacy ambiguity into one authoritative rework dispatch. Omitted assertions remain ordinary work. A matching coder dispatch already pending is not ambiguous and never re-arms code rework.

## Human markers (optional)

Roles may print `PLAN_READY`, `VERDICT: APPROVED`, etc. for humans. Tools must not depend on them.
