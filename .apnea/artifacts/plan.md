---
status: done
---

# Plan: validate the approved PR description and finish the run

## Goal restatement

Use one final, completion-only phase to validate the existing approved `pr-description.md` against the actual non-Apnea `jj` implementation diff and retained verification evidence. Confirm the title, exactly two-sentence TL;DR, quantified files table, architecture, reviewer notes, tests, prohibited-reference hygiene, and complete product-tree preservation. Leave the approved artifact unchanged unless a concrete factual error exists, preserve verified commits and Apnea records, create no further phase, and return control to the orchestrator for `apnea commit --done`; do not commit, push, or open a PR in this phase.

## Baseline

- `main` and approved implementation/evidence revision `eec2b96b` have common ancestor `6b39329e`.
- Excluding `.apnea/**`, `main..eec2b96b` contains 44 changed files and `22453 insertions(+), 3557 deletions(-)`.
- `92157645` is the approved PR-description revision in the current ancestry, and `.apnea/artifacts/phase-01/round-1/code-review.md` records `verdict: APPROVED`.
- The current approved `pr-description.md` is byte-identical to the version at `92157645` before this final validation begins.

## Phases

### Phase 1 — Revalidate the approved artifact and close the run

#### Intent

Perform a read-mostly factual audit of the public PR description against the complete non-Apnea implementation range, retained test/certification evidence, and approved review. Finish without product changes. Only a demonstrable factual error may justify the smallest possible edit to `pr-description.md`; stylistic rewriting or edits made merely to create phase activity are forbidden.

#### Files likely touched

- Expected repository/product changes: none.
- Conditional factual correction only: `pr-description.md`.
- The run harness may write only the exact phase artifacts and records dispatched to it.

Do not manually edit `.apnea/state.json`, any other Apnea record, product code, tests, documentation, manifests, lockfiles, configuration, bookmarks, commit descriptions, or history.

#### Ordered work

1. Establish the baseline before any optional edit: confirm the prior PR-description review is approved, `eec2b96b` still resolves, `92157645` remains in the current ancestry, the common ancestor remains `6b39329e`, and the working-copy description is byte-identical to its approved revision.
2. Inspect the log plus the complete non-Apnea `main..eec2b96b` name list, statistics, and diff. Reconcile every public claim with the implementation rather than relying only on section-presence checks.
3. Confirm the first heading is exactly `refactor(music): centralize cross-host media sessions` and the TL;DR has exactly two natural sentences accurately describing the former split ownership, the owner-only Effect v4 session, authoritative shared state, and verified 24-client isolation.
4. Confirm the files table reports 44 files and `+22453 / -3557`, marks exactly one start point, and points only to real core, protocol, lifecycle, provider, host-adapter, packaging, and test seams present in the implementation.
5. Validate `Why`, `How`, and `Reviewer notes` against the code: singleton/provider authority, Effect scopes and Layers, negotiated protocol and revision fencing, bounded connection/artwork work, reconnect no-replay semantics, global FIFO command ordering, conservative runtime cleanup, idle shutdown, and presentation-only host boundaries must all remain accurate.
6. Validate `Tests` and `Residual risk` against retained evidence. Preserve the four exact approved commands, and ensure the pinned OpenCode/Pi mixed-host VLC result is described as prior manual certification with its provider, host-version, platform, selected-item, and daemon-generation limits. Do not rerun the repository gate, package smokes, pinned hosts, or VLC session in this completion phase.
7. Scan the public text for prohibited workflow, orchestration, agent/assistant, generated-artifact, internal-record, or attribution references; none may appear.
8. Compare the complete repository tree from `eec2b96b` to `@`, excluding only orchestrator-managed `.apnea/**` paths and the conditionally permitted `pr-description.md`. Reject any other changed or newly added path, and confirm no malformed non-Apnea diff exists.
9. If every factual check passes, leave `pr-description.md` byte-for-byte unchanged and report readiness to finish. If a concrete factual error is found, record the discrepancy, make only the minimum correction to `pr-description.md`, rerun all content and preservation checks, and explicitly expose the deviation from the approved `92157645` text for review; do not repair product code or broaden scope.
10. Do not create another phase. Do not commit, squash, rebase, abandon, push, publish, or create/update a PR. After phase approval, the orchestrator alone runs `apnea commit --done`.

#### Acceptance checks

- The prior description review remains `APPROVED`; `eec2b96b`, `92157645`, and base `6b39329e` remain resolvable and preserved.
- Before optional work, `pr-description.md` matches the approved `92157645` content exactly. At completion it is still identical unless review can point to a concrete factual error and the corresponding minimal correction.
- Front matter is exactly `status: done`, and the first heading has the approved Conventional Commit title.
- The TL;DR contains exactly two natural sentences, and its ownership, architecture, authoritative-state, and 24-client claims are supported by the implementation and evidence.
- The files table matches the complete non-Apnea 44-file, `+22453 / -3557` diff, has exactly one start point, and names real review seams.
- Architecture and reviewer notes accurately expose authority, ordering, lifecycle, isolation, cleanup, reconnect, artwork, idle-lifetime, and host-boundary semantics.
- The four approved test commands and manual-certification statement match retained evidence and state honest residual limits.
- The PR text contains no prohibited attribution or internal workflow references.
- The complete repository tree is identical to `eec2b96b` except for orchestrator-managed `.apnea/**` content and the conditionally permitted `pr-description.md`; therefore no product code, test, documentation, manifest, lockfile, configuration, or other non-Apnea content changes.
- No verified revision or Apnea record is manually rewritten, discarded, or cleaned up, and no commit, push, publication, PR operation, or further phase occurs.

#### Verify commands

Run each command independently from the repository root. Every command below is one self-contained shell line; do not share variables, use multiline shell constructs, or combine the listed commands into a stateful script.

Baseline approval and revision preservation:

```bash
grep -Fq 'verdict: APPROVED' .apnea/artifacts/phase-01/round-1/code-review.md
```

```bash
test "$(jj log -r eec2b96b --no-graph -T 'commit_id.short(8)')" = eec2b96b
```

```bash
test "$(jj log -r 'heads(ancestors(eec2b96b) & ancestors(main))' --no-graph -T 'commit_id.short(8)')" = 6b39329e
```

```bash
test "$(jj log -r '92157645 & ancestors(@)' --no-graph -T 'commit_id.short(8)')" = 92157645
```

```bash
test "$(git hash-object pr-description.md)" = "$(jj file show -r 92157645 pr-description.md | git hash-object --stdin)"
```

The hash command is the pre-edit approved-artifact guard. It must also pass at completion when no factual correction was necessary; if a correction was necessary, its failure must be explicitly accounted for by the minimal reviewed diff rather than hidden.

Complete implementation-range inspection and quantified table guards:

```bash
jj log -r 'main..eec2b96b' --no-graph -T 'commit_id.short(8) ++ " " ++ description.first_line() ++ "\n"'
```

```bash
test "$(jj diff --from main --to eec2b96b --name-only -- 'all() ~ glob:".apnea/**"' | wc -l | tr -d ' ')" = 44
```

```bash
test "$(jj diff --from main --to eec2b96b --stat -- 'all() ~ glob:".apnea/**"' | tail -n 1)" = '44 files changed, 22453 insertions(+), 3557 deletions(-)'
```

```bash
jj diff --from main --to eec2b96b --name-only -- 'all() ~ glob:".apnea/**"'
```

```bash
jj diff --from main --to eec2b96b -- 'all() ~ glob:".apnea/**"'
```

PR-description structure and evidence guards:

```bash
python3 -c 'from pathlib import Path; text=Path("pr-description.md").read_text(); assert text.startswith("---\nstatus: done\n---\n\n# refactor(music): centralize cross-host media sessions\n")'
```

```bash
python3 -c 'import re; from pathlib import Path; text=Path("pr-description.md").read_text(); match=re.search(r"(?ms)^## TL;DR\s*\n(.*?)(?=^## |\Z)",text); assert match; sentences=[part for part in re.split(r"(?<=[.!?])\s+"," ".join(match.group(1).split())) if part]; assert len(sentences)==2,(len(sentences),sentences)'
```

```bash
grep -Fq 'Files to review (44, +22453 / -3557)' pr-description.md && test "$(grep -Fc '*(start here)*' pr-description.md)" = 1
```

```bash
grep -Fq '## Why' pr-description.md && grep -Fq '## How' pr-description.md && grep -Fq '## Reviewer notes' pr-description.md && grep -Fq '## Tests' pr-description.md && grep -Fq '## Residual risk' pr-description.md
```

```bash
grep -Fq '`bun run check`' pr-description.md && grep -Fq '`bunx nx run music-core:smoke`' pr-description.md && grep -Fq '`bunx nx run opencode-music-player:smoke`' pr-description.md && grep -Fq '`bunx nx run pi-music-dock:smoke`' pr-description.md
```

```bash
grep -Fq 'OpenCode `0.0.0-next-17386` and Pi `0.84.0`' pr-description.md && grep -Fq 'canonical VLC restoration' pr-description.md && grep -Fq 'daemon-generation continuity' pr-description.md
```

```bash
! grep -Eiq '(apnea|herdr|workflow|orchestrat|dispatch|coder-result|phase-package|generated[ -]artifact|agent|assistant|claude|chatgpt|copilot|AI-generated|Co-Authored-By)' pr-description.md
```

Complete product-tree preservation and diff hygiene:

```bash
test -z "$(jj diff --from eec2b96b --to @ --name-only -- 'all() ~ glob:".apnea/**" ~ file:"pr-description.md"')"
```

```bash
git diff --check -- . ':(exclude).apnea'
```

The complete-tree command examines every changed or newly added tracked path and excludes only `.apnea/**` plus `pr-description.md`; it directly addresses the prior reviews' repository-wide preservation finding. The structural commands are guards, not substitutes for reading the prose against the full implementation diff. Do not use unfiltered `jj status` as an acceptance gate because orchestrator-managed Apnea records are intentionally present.

#### Dependencies

- Existing approved `pr-description.md` and `.apnea/artifacts/phase-01/round-1/code-review.md`.
- Preserved `main`, `eec2b96b`, `6b39329e`, and `92157645` revisions.
- Retained approved full-gate, package-smoke, pinned-host, and mixed-host VLC certification evidence.
- Read access plus `jj`, Git, Python 3, and standard shell tools.

#### Non-goals

- Rewriting, expanding, or polishing an already accurate PR description.
- Re-running expensive automated gates or interactive media certification.
- Changing product code, tests, docs, package metadata, lockfiles, configuration, bookmarks, commit descriptions, or history.
- Editing `.apnea/state.json` or manually cleaning/reconstructing any Apnea record.
- Committing, squashing, rebasing, abandoning, pushing, publishing, or creating/updating a pull request.
- Creating any second phase.

## Definition of done

The sole final phase is approved with `pr-description.md` factually aligned to the complete non-Apnea `main..eec2b96b` implementation diff and retained evidence; its title, two-sentence TL;DR, files table, architecture, reviewer notes, tests, residual risk, and prohibited-reference hygiene all pass inspection; the approved artifact remains unchanged absent an explicitly reviewed factual correction; every applicable independent one-line check passes; and the complete product tree, verified revisions, and Apnea records remain preserved. No further phase is created, no commit/push/PR operation occurs, and control returns to the orchestrator for `apnea commit --done`.
