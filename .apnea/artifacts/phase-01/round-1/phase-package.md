---
status: done
---

# Phase 1 package: write the final shared music-session PR description

## Intent

Create only the final reviewer-oriented `pr-description.md` at the exact path named by the coder dispatch. Describe the completed Effect v4 migration from separate Pi and OpenCode provider ownership to one shared same-user music session, using the actual product diff and approved verification rather than commit-message inference or internal execution history.

This is a writing-only phase. The implementation, full repository gate, packed daemon and host smokes, and real mixed-host VLC certification are already approved; do not rerun or modify them.

## Files to touch

- The exact `pr-description.md` path supplied by the coder dispatch, and no other authored file.

Use the dispatch path literally. Do not derive, relocate, or guess it.

## Files not to touch

- `.apnea/state.json`.
- Any other `.apnea` record.
- `.prettierignore`, `README.md`, `bun.lock`, `docs/**`, or `packages/**`.
- Commit descriptions, bookmarks, Git history, package metadata, configuration, tests, fixtures, or documentation.

Do not commit, squash, push, publish, or create/update a GitHub PR.

## Fixed evidence boundary

- Base: `main`, whose common ancestor with the approved implementation is `6b39329e` (`refactor(music): adopt authoritative snapshots and transport queues (#44)`).
- Approved implementation/evidence head: `eec2b96b` (`test(release): verify full repository gate`).
- Product-only range: `.prettierignore`, `README.md`, `bun.lock`, `docs`, and `packages`.
- Planning-time shape: 44 files, `+22453 / -3557`.

Revalidate these facts with the commands below. If the product range differs, stop and report the discrepancy instead of silently changing the review story.

## Exact steps

1. Read the `new-pr` skill before drafting.
2. In a regular pane at `/Users/nachovazquez/work/1-projects/naxodev/ai`, run every read-only evidence command below independently. Confirm the base/head identity, inspect the complete product diff—not only its stat or commit subjects—and scan the latest 15 merged PR titles.
3. Read the architecture and principal implementation seams before writing:
   - `docs/music-session-architecture.html`
   - `packages/music-core/session/coordinator.ts`
   - `packages/music-core/session/protocol.ts`
   - `packages/music-core/session/server.ts`
   - `packages/music-core/session/client.ts`
   - `packages/music-core/session/provider.ts`
   - `packages/music-core/session/config.ts`
   - `packages/opencode-music-player/index.tsx`
   - `packages/opencode-music-player/system-media.ts`
   - `packages/pi-music-dock/extensions/music-dock/index.ts`
   - the three package-smoke scripts and representative session/host tests shown by the diff.
4. Create or replace only the exact dispatched `pr-description.md`. Its YAML front matter must contain only `status: done`.
5. Make the first Markdown heading a lowercase-imperative Conventional Commit title. It must describe the entire cross-host migration; `refactor(music)` is the expected type/scope unless the actual diff and recent merged titles support a better choice. Do not title the PR after a late test or hello-reset fix.
6. Follow a reviewer-oriented large-PR structure:
   - `## TL;DR`
   - `**Files to review (N, +X / -Y):**` and a Markdown table
   - `## Why`
   - `## How`
   - `## Reviewer notes`
   - `## Tests`
   - `## Residual risk`

   Add a compact architecture visual only if it communicates the changed ownership/data flow faster than prose; do not decorate the description or diagram unchanged UI details.
7. Make the TL;DR exactly two sentences. Sentence one names the old problem concretely: Pi and OpenCode independently sampled and commanded media providers. Sentence two states that one owner-only Effect v4 session now owns transport and authoritative media state for both hosts and includes a concrete verified fact, such as isolation across 24 clients.
8. Use the revalidated totals in the files-to-review label. Mark exactly one row `*(start here)*`; use `packages/music-core/session/coordinator.ts` because it exposes authority, polling, global FIFO command handling, fan-out, and artwork ownership. Continue the table in useful review order through protocol, server/client lifecycle, host adapters, packaging, and focused tests. Include only key files, not all 44 paths.
9. In `Why`, explain the review-relevant failure mode: two host-owned provider graphs could race, diverge, and give each UI a different view of transport/media state. Do not repeat the TL;DR verbatim.
10. In `How`, explain the final architecture top-down rather than narrating files or commits:
    - owner-only Unix-socket startup/bind coordination selects one provider graph;
    - Effect v4 scopes and Layers own provider, coordinator, listener, connections, queues, polling, and finalizers;
    - schema-validated hello/capability negotiation and revisioned replay establish authority;
    - bounded per-client queues and artwork work isolate slow or failing peers;
    - reconnecting clients retain presentation state but never replay uncertain commands;
    - OpenCode and Pi remain presentation adapters while the packaged Node daemon is host-neutral.
11. In `Reviewer notes`, use one bullet per non-obvious decision and bold only its short headline. Cover global FIFO and indeterminate-on-loss command semantics, authoritative snapshot/revision fencing, conservative owner/mode/symlink cleanup, capability-negotiated bounded artwork, idle shutdown after the last negotiated client, and host UI remaining outside the core.
12. In `Tests`, list these approved commands exactly; do not substitute aliases or add `--skip-nx-cache`:
    - `bun run check`
    - `bunx nx run music-core:smoke`
    - `bunx nx run opencode-music-player:smoke`
    - `bunx nx run pi-music-dock:smoke`

    Report the approved live check separately as manual certification, not as a reproducible repository command. State that OpenCode `0.0.0-next-17386` and Pi `0.84.0` loaded the checkout packages in their isolated host setup and controlled the same selected VLC item; both control directions, Pi reload and `/quit`, post-Pi OpenCode control, normal OpenCode exit, canonical VLC restoration, daemon-generation continuity, and owned cleanup passed. Do not describe panes, profiles, operators, evidence files, retries, or failed attempts in the PR content.
13. In `Residual risk`, state that live coverage used pinned pre-release host versions, one selected VLC item on macOS, and one already-running daemon generation. Provider, host-version, and platform variance remain outside that certification. Do not imply source switching, daemon replacement, broad platform certification, package publication, or PR creation.
14. Edit against the large-PR standard: active voice, present tense, concrete wording, short paragraphs, no duplicated file-table/How narration, no commit archaeology, and no unsupported claims. Include no references to workflow tooling, agents, assistants, AI/Claude, generated artifacts, dispatches, internal records, or attribution trailers.
15. Run every post-write command below independently. Then manually confirm the TL;DR reads as exactly two natural sentences and every prose claim follows from the product diff or approved results.

## Acceptance checks

- The exact dispatched `pr-description.md` is the only authored write.
- The file starts with front matter containing only `status: done`; the first Markdown heading is a valid Conventional Commit title aligned with recent merged PRs and the full migration.
- The TL;DR is exactly two sentences and gives the problem, solution, and one concrete verified fact.
- The files table reports the revalidated 44-file, `+22453 / -3557` product range if unchanged, marks exactly one start point, and supplies a useful review order.
- `Why` explains the ownership problem; `How` explains the shared-session architecture; `Reviewer notes` records the non-obvious semantics and tradeoffs.
- `Tests` contains all four exact approved commands and clearly distinguishes the already completed mixed-host VLC certification from runnable repository checks.
- `Residual risk` accurately limits the live certification to its pinned hosts, selected VLC item, macOS environment, and daemon-generation scenario.
- The description is written for reviewers and does not echo the diff file by file or narrate commit chronology.
- The description contains no workflow, agent, assistant, AI/Claude, generated-artifact, internal-record, dispatch, or attribution references.
- No product file differs from approved head `eec2b96b`; `.apnea/state.json` is not manually edited; no commit, push, publication, or PR operation occurs.

## Verify commands

Run each command separately from the repository root. Every line is self-contained and relies on no variable or temporary state from another command.

### Evidence refresh before writing

```bash
test "$(jj log -r 'heads(ancestors(eec2b96b) & ancestors(main))' --no-graph -T 'commit_id.short(8)')" = 6b39329e
```

```bash
jj log -r 'main..eec2b96b' --no-graph -T 'commit_id.short(8) ++ " " ++ description.first_line() ++ "\n"'
```

```bash
jj diff --from main --to eec2b96b --summary -- .prettierignore README.md bun.lock docs packages
```

```bash
jj diff --from main --to eec2b96b --stat -- .prettierignore README.md bun.lock docs packages
```

```bash
jj diff --from main --to eec2b96b -- .prettierignore README.md bun.lock docs packages
```

```bash
test "$(jj diff --from main --to eec2b96b --name-only -- .prettierignore README.md bun.lock docs packages | wc -l | tr -d ' ')" = 44
```

```bash
gh pr list --state merged --limit 15 --json title --jq '.[].title'
```

### Independent checks after writing

Each command prompts for the literal `pr-description.md` path from the coder dispatch so no path is guessed and no shell value crosses commands.

```bash
printf 'Exact dispatched pr-description.md path: '; IFS= read -r p; test "$(basename "$p")" = pr-description.md && test -f "$p" && test ! -L "$p"
```

```bash
printf 'Exact dispatched pr-description.md path: '; IFS= read -r p; test "$(head -n 3 "$p")" = "$(printf '%s\n' '---' 'status: done' '---')"
```

```bash
printf 'Exact dispatched pr-description.md path: '; IFS= read -r p; grep -Eq '^# (feat|fix|chore|refactor|docs|test|style|perf|build|ci|revert)(\([a-z0-9-]+\))?!?: [a-z0-9]' "$p"
```

```bash
printf 'Exact dispatched pr-description.md path: '; IFS= read -r p; python3 -c 'import re,sys; from pathlib import Path; text=Path(sys.argv[1]).read_text(); match=re.search(r"(?ms)^## TL;DR\s*\n(.*?)(?=^## |\Z)",text); assert match; body=" ".join(match.group(1).split()); sentences=[s for s in re.split(r"(?<=[.!?])\s+",body) if s]; assert len(sentences)==2,(len(sentences),sentences)' "$p"
```

```bash
printf 'Exact dispatched pr-description.md path: '; IFS= read -r p; grep -Fq 'Files to review' "$p" && test "$(grep -Fc '*(start here)*' "$p")" = 1 && grep -Fq '44' "$p" && grep -Fq '+22453 / -3557' "$p"
```

```bash
printf 'Exact dispatched pr-description.md path: '; IFS= read -r p; grep -Fq '## Why' "$p" && grep -Fq '## How' "$p" && grep -Fq '## Reviewer notes' "$p" && grep -Fq '## Tests' "$p" && grep -Fq '## Residual risk' "$p"
```

```bash
printf 'Exact dispatched pr-description.md path: '; IFS= read -r p; grep -Fq '`bun run check`' "$p" && grep -Fq '`bunx nx run music-core:smoke`' "$p" && grep -Fq '`bunx nx run opencode-music-player:smoke`' "$p" && grep -Fq '`bunx nx run pi-music-dock:smoke`' "$p"
```

```bash
printf 'Exact dispatched pr-description.md path: '; IFS= read -r p; ! grep -Eiq '(apnea|herdr|workflow|dispatch|coder-result|phase-package|generated[ -]artifact|agent|assistant|claude|AI-generated|Co-Authored-By)' "$p"
```

```bash
test -z "$(jj diff --from eec2b96b --to @ --name-only -- .prettierignore README.md bun.lock docs packages)"
```

```bash
git diff --check -- . ':(exclude).apnea'
```

The automated sentence check is a guard, not a substitute for reading the TL;DR. The unfiltered working-copy status is not an acceptance oracle because pre-existing records are intentionally outside the product-scoped range.

## Dependencies

- Read access to `main`, `eec2b96b`, the complete product diff, architecture document, implementation files, and tests.
- The already approved full repository gate, packed daemon/OpenCode/Pi smokes, and mixed-host VLC certification.
- `jj`, `gh`, Python 3, and the coder dispatch containing the exact output path.

## Non-goals

- Implementing, fixing, formatting, or refactoring product code.
- Re-running `bun run check`, package smokes, pinned hosts, Pi profiles, or VLC certification.
- Changing docs, tests, manifests, lockfiles, config, history, bookmarks, or `.apnea/state.json`.
- Cleaning or altering any daemon, peer, host process, profile, pane, or media state.
- Publishing packages, committing, pushing, or creating/updating a PR.
- Writing a changelog, commit-by-commit narrative, exhaustive 44-file tour, or internal execution report.
