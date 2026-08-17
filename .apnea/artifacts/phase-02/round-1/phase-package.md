---
status: done
---

# Phase 2 package: validate the approved PR description and finish

## Intent

Finish the run without further implementation or writing. Phase 1 already created `pr-description.md`, its code review is `APPROVED`, and the approved plan defines no additional implementation phase. Revalidate that the approved description and product tree remain intact, then report completion without editing any file, committing, pushing, or opening/updating a PR.

## Files to touch

- None.

`pr-description.md` is already complete and approved. Do not rewrite it merely to create phase activity.

## Files not to touch

- `pr-description.md`.
- `.apnea/state.json` or any other record.
- `.prettierignore`, `README.md`, `bun.lock`, `docs/**`, or `packages/**`.
- Tests, manifests, lockfiles, configuration, bookmarks, commit descriptions, or history.

The run harness may create the coder-result artifact required by its protocol; do not manually create or alter any other path.

## Exact steps

1. Read `.apnea/artifacts/phase-01/round-1/coder-result.md` and `.apnea/artifacts/phase-01/round-1/code-review.md`. Confirm that Phase 1 created `pr-description.md`, all specified checks passed, and review verdict is `APPROVED`.
2. Read `pr-description.md` without editing it. Confirm it remains the reviewer-oriented large-PR description approved in Phase 1.
3. Run every command below independently from `/Users/nachovazquez/work/1-projects/naxodev/ai`. Do not use variables or temporary state shared between commands.
4. If any check fails, stop and report the exact failure. Do not repair product code, rewrite the approved description, alter records, or broaden this completion-only phase.
5. If all checks pass, write the coder result stating that no source or PR-description change was necessary, the approved output remains valid, and the run is ready to finish.
6. Do not run `bun run check`, package smokes, pinned hosts, Pi profiles, or VLC certification again; those gates are already approved.
7. Do not commit, squash, push, publish, or invoke `gh pr create`/`gh pr edit`.

## Acceptance checks

- Phase 1's code review still has `verdict: APPROVED`.
- `pr-description.md` is unchanged in the current working copy relative to its parent.
- Its front matter contains only `status: done`, and its first heading is a Conventional Commit title.
- Its TL;DR remains exactly two sentences.
- It retains the files-to-review table with exactly one start point, `Why`, `How`, `Reviewer notes`, `Tests`, and `Residual risk`.
- It retains all four exact approved commands and the bounded mixed-host VLC certification statement.
- It contains no workflow, agent, assistant, AI/Claude, generated-artifact, dispatch, internal-record, or attribution references.
- The product tree remains identical to approved implementation head `eec2b96b` for `.prettierignore`, `README.md`, `bun.lock`, `docs`, and `packages`.
- No file is authored in this phase other than the harness-required coder result; no commit, push, publication, or PR operation occurs.

## Verify commands

Run each line separately from the repository root. Every command is self-contained and relies on no cross-command shell variable.

```bash
grep -Fq 'verdict: APPROVED' .apnea/artifacts/phase-01/round-1/code-review.md
```

```bash
test -z "$(jj diff --from @- --to @ --name-only -- pr-description.md)"
```

```bash
test "$(head -n 3 pr-description.md)" = "$(printf '%s\n' '---' 'status: done' '---')"
```

```bash
grep -Eq '^# (feat|fix|chore|refactor|docs|test|style|perf|build|ci|revert)(\([a-z0-9-]+\))?!?: [a-z0-9]' pr-description.md
```

```bash
python3 -c 'import re; from pathlib import Path; text=Path("pr-description.md").read_text(); match=re.search(r"(?ms)^## TL;DR\s*\n(.*?)(?=^## |\Z)",text); assert match; body=" ".join(match.group(1).split()); sentences=[s for s in re.split(r"(?<=[.!?])\s+",body) if s]; assert len(sentences)==2,(len(sentences),sentences)'
```

```bash
grep -Fq 'Files to review' pr-description.md && test "$(grep -Fc '*(start here)*' pr-description.md)" = 1 && grep -Fq '+22453 / -3557' pr-description.md
```

```bash
grep -Fq '## Why' pr-description.md && grep -Fq '## How' pr-description.md && grep -Fq '## Reviewer notes' pr-description.md && grep -Fq '## Tests' pr-description.md && grep -Fq '## Residual risk' pr-description.md
```

```bash
grep -Fq '`bun run check`' pr-description.md && grep -Fq '`bunx nx run music-core:smoke`' pr-description.md && grep -Fq '`bunx nx run opencode-music-player:smoke`' pr-description.md && grep -Fq '`bunx nx run pi-music-dock:smoke`' pr-description.md
```

```bash
! grep -Eiq '(apnea|herdr|workflow|dispatch|coder-result|phase-package|generated[ -]artifact|agent|assistant|claude|AI-generated|Co-Authored-By)' pr-description.md
```

```bash
test "$(jj log -r 'heads(ancestors(eec2b96b) & ancestors(main))' --no-graph -T 'commit_id.short(8)')" = 6b39329e
```

```bash
test -z "$(jj diff --from eec2b96b --to @ --name-only -- .prettierignore README.md bun.lock docs packages)"
```

```bash
git diff --check -- . ':(exclude).apnea'
```

The sentence check is only a guard; read the TL;DR once to confirm it consists of two natural sentences. Do not use unfiltered `jj status` as a phase acceptance check because existing run records are intentionally outside the product boundary.

## Dependencies

- Approved Phase 1 coder result and code review.
- Existing `pr-description.md` in the repository root.
- Approved implementation/evidence head `eec2b96b` and `main` base.
- `jj`, Python 3, and read access to the repository.

## Non-goals

- Revising or expanding `pr-description.md` after approval.
- Re-reading the entire product diff or rescanning merged PR titles; Phase 1 already completed and recorded those required steps.
- Re-running any automated package/repository gate or real-host certification.
- Changing product code, tests, docs, manifests, lockfiles, configuration, history, bookmarks, or records.
- Starting, stopping, signaling, or cleaning any daemon, host, profile, pane, peer, or media source.
- Committing, pushing, publishing, or creating/updating a PR.
