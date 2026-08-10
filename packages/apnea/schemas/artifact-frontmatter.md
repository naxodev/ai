# Artifact front-matter (v1)

YAML between `---` lines at file start.

## All artifacts

```yaml
status: done
```

`status` other than `done` is invalid in v1.

## Review artifacts (plan-review, code-review)

```yaml
status: done
verdict: APPROVED | CHANGES_REQUIRED
rework: code | phase_package # code-review CHANGES_REQUIRED only
nits: | # optional string; meaningful only with APPROVED
  ...
```

- Missing `verdict` on a review artifact → invalid.
- `nits` with `CHANGES_REQUIRED` is allowed but ignored by the commit gate.
- A code-review `CHANGES_REQUIRED` may set `rework` to `code` or `phase_package`.
- Missing `rework` means `code` for compatibility with existing reviews.
- Omit `rework` from plan reviews and approved code reviews.
- Commit gate cares only: `verdict == APPROVED` and verify commands exit 0.

## Non-review artifacts

plan, phase-package, coder-result, pr-description:

```yaml
status: done
```

No `verdict` field expected.
