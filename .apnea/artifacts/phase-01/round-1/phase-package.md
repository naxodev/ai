---
status: done
---

# Phase 1 package: revalidate the approved PR description and finish the run

## Intent

Perform the run's sole final phase as a read-only factual audit. Validate the existing approved `pr-description.md` against the complete non-Apnea `main..eec2b96b` implementation diff, the approved review, and retained verification evidence. Preserve the description, product content, records, and history exactly, and write only the harness-required coder result. Do not create another phase; after approval, the orchestrator will commit this phase with `apnea commit --done`.

## Files to touch

- Only the exact coder-result artifact dispatched by the run harness.

No product or repository content is to be edited in this phase. `pr-description.md` must remain byte-for-byte identical to revision `92157645`. If validation exposes a factual error, stop and report it in the coder result rather than changing the approved artifact.

## Files not to touch

- `pr-description.md`.
- `.apnea/state.json` or any other Apnea record manually.
- Product code or tests under `packages/**`.
- `.prettierignore`, `README.md`, `bun.lock`, or `docs/**`.
- Any other documentation, manifest, lockfile, configuration, task file, or repository content.
- Bookmarks, commit descriptions, verified revisions, or history.

Do not delete, clean, reconstruct, or normalize existing Apnea records. Their working-copy presence is expected.

## Exact steps

1. From the repository root, read `pr-description.md`, `.apnea/artifacts/phase-01/round-1/coder-result.md`, and `.apnea/artifacts/phase-01/round-1/code-review.md`. Do not edit them.
2. Run the baseline commands below independently. Confirm the earlier description review says `APPROVED`, `eec2b96b` still resolves, the common ancestor with `main` remains `6b39329e`, `92157645` remains in the current ancestry, and `pr-description.md` hashes exactly to the approved content at `92157645`.
3. Inspect the complete non-Apnea `main..eec2b96b` log, path list, statistics, and diff using the commands below. Do not substitute a hand-picked path list for the complete non-Apnea fileset.
4. Compare the title and TL;DR to the implementation. Require the exact title `refactor(music): centralize cross-host media sessions` and exactly two natural TL;DR sentences. Verify that those sentences accurately state the former independent host ownership and the owner-only Effect v4 session with authoritative shared state and verified 24-client isolation.
5. Audit the files table against the path list and diff. Require 44 files, `+22453 / -3557`, exactly one `*(start here)*`, and only real review seams covering the coordinator, protocol, server/client lifecycle, config/provider boundary, daemon/package export, OpenCode adapter, Pi adapter, and relevant tests.
6. Read `Why`, `How`, and every reviewer note against the implementation. Confirm singleton/provider authority, Effect scopes and Layers, hello/capability negotiation, revision and generation fencing, bounded connection and artwork work, reconnect without uncertain-command replay, global FIFO command ordering, conservative cleanup, negotiated-client idle lifetime, and presentation-only host boundaries.
7. Validate `Tests` and `Residual risk` against retained evidence. Require the four exact approved commands and an honest statement of the prior manual certification: pinned OpenCode `0.0.0-next-17386`, Pi `0.84.0`, one selected VLC item on macOS, daemon-generation continuity, cleanup/restoration behavior, and the remaining provider/version/platform limits. Do not rerun `bun run check`, package smokes, pinned hosts, Pi profiles, or VLC certification.
8. Run the prohibited-reference scan. Public PR text must not mention Apnea/Herdr, orchestration or dispatch, agents/assistants, generated artifacts, internal phase records, AI tools, or attribution trailers.
9. Run the complete product-preservation command from `eec2b96b` to `@`. It must find no changed or newly added path after excluding only orchestrator-managed `.apnea/**` and the already-approved `pr-description.md`. Run the non-Apnea whitespace/error check as well.
10. If all factual checks pass, leave every repository file unchanged. Write only the dispatched coder result, stating that the approved description remains valid and unchanged, identifying the inspected implementation range and evidence, listing each verification result, and declaring the run ready for final approval.
11. If any structural, factual, evidence, hygiene, revision, or preservation check fails, stop and report the exact failure and evidence in the coder result. Do not repair product code, edit `pr-description.md`, alter records, or broaden the phase.
12. Stop after this phase. Do not invoke `apnea commit --done` yourself and do not request a later phase. The orchestrator will commit this phase with `--done` after approval. Do not commit, squash, rebase, abandon, push, publish, or create/update a PR.

## Acceptance checks

- The earlier PR-description review remains `APPROVED`; revisions `eec2b96b`, `6b39329e`, and `92157645` remain preserved and resolvable as specified.
- `pr-description.md` is byte-identical to its approved `92157645` version before and after validation; any mismatch fails the phase.
- Front matter is exactly `status: done`; the first heading is the exact approved Conventional Commit title.
- The TL;DR has exactly two natural sentences, and all ownership, Effect v4, authoritative-state, and 24-client claims are factual.
- The files table matches the complete non-Apnea 44-file, `+22453 / -3557` implementation diff, marks exactly one start point, and names real review seams.
- Architecture and reviewer notes match the implementation's authority, protocol, ordering, lifecycle, isolation, cleanup, artwork, reconnect, idle-lifetime, and host-boundary behavior.
- Tests list the four exact approved commands, and manual certification plus residual risk match retained evidence without overstating coverage.
- No prohibited attribution, workflow, orchestration, agent, generated-artifact, or internal-record reference appears in public PR text.
- No changed or newly added path exists between `eec2b96b` and `@` outside `.apnea/**` and the already-approved `pr-description.md`; no product code, tests, docs, manifests, lockfiles, configuration, or other non-Apnea content changes.
- The coder result is the only write made by the phase.
- No Apnea record is manually edited or cleaned; no verified revision or history is altered; no command commits, pushes, publishes, or opens/updates a PR.
- The coder result reports completion of this phase only and requests no further phase; after approval, the orchestrator commits it with `--done`.

## Verify commands

Run every command below separately from the repository root. Each command is an independent, self-contained single shell line. Do not share shell variables, depend on state created by an earlier command, use multiline shell constructs, or combine the commands into a script.

### Approved baseline and revisions

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

The hash command is mandatory and must pass. A mismatch fails this read-only completion phase; do not edit the approved artifact.

### Complete implementation range

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

### PR-description structure, evidence, and hygiene

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

### Complete product-tree preservation

```bash
test -z "$(jj diff --from eec2b96b --to @ --name-only -- 'all() ~ glob:".apnea/**" ~ file:"pr-description.md"')"
```

```bash
git diff --check -- . ':(exclude).apnea'
```

The complete-tree command examines every tracked path and excludes only `.apnea/**` plus `pr-description.md`; it is the repository-wide preservation gate, not merely a check of known product directories. The structural commands do not replace the required human reading of the full diff and prose. Do not use unfiltered `jj status` as an acceptance gate because orchestrator-managed Apnea changes are expected.

## Dependencies

- Approved full plan at `.apnea/artifacts/plan.md`.
- Existing approved `pr-description.md`, prior coder result, and prior approved review in the dispatched phase paths.
- Preserved `main`, `eec2b96b`, `6b39329e`, and `92157645` revisions.
- Retained approved repository-gate, package-smoke, pinned-host, and mixed-host VLC certification evidence.
- Read access plus `jj`, Git, Python 3, and standard shell tools.

## Non-goals

- Editing `pr-description.md` for any reason in this read-only completion phase.
- Re-running repository/package gates or interactive host/media certification.
- Changing product code, tests, docs, manifests, lockfiles, package metadata, configuration, bookmarks, commit descriptions, or history.
- Editing `.apnea/state.json` or manually changing, deleting, or cleaning any Apnea record.
- Starting, stopping, signaling, probing, or cleaning a daemon, host, profile, pane, peer, or media source.
- Committing, squashing, rebasing, abandoning, pushing, publishing, or creating/updating a PR.
- Invoking `apnea commit --done`; the orchestrator commits this phase with `--done` after approval.
- Creating or requesting any further phase.
