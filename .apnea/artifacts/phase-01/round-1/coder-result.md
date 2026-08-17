---
status: done
---

Created `pr-description.md` with the requested reviewer-oriented description for the shared cross-host music session migration. No product files or state records were changed.

Files touched:

- `pr-description.md`
- `.apnea/artifacts/phase-01/round-1/coder-result.md`

Verification transcript (all commands ran from the repository root):

```text
$ test "$(jj log -r 'heads(ancestors(eec2b96b) & ancestors(main))' --no-graph -T 'commit_id.short(8)')" = 6b39329e
exit: 0

$ jj log -r 'main..eec2b96b' --no-graph -T 'commit_id.short(8) ++ " " ++ description.first_line() ++ "\n"'
exit: 0
tail: eec2b96b test(release): verify full repository gate
      bd952919 fix(music): tolerate daemon hello reset window
      ...
      e7103663 refactor(music): own provider lifecycle with Effect

$ jj diff --from main --to eec2b96b --summary -- .prettierignore README.md bun.lock docs packages
exit: 0
tail: 44 changed product paths, including the session core, OpenCode adapter, and Pi adapter.

$ jj diff --from main --to eec2b96b --stat -- .prettierignore README.md bun.lock docs packages
exit: 0
tail: 44 files changed, 22453 insertions(+), 3557 deletions(-)

$ jj diff --from main --to eec2b96b -- .prettierignore README.md bun.lock docs packages
exit: 0
tail: complete product diff inspected; command emitted 27,268 lines.

$ test "$(jj diff --from main --to eec2b96b --name-only -- .prettierignore README.md bun.lock docs packages | wc -l | tr -d ' ')" = 44
exit: 0

$ gh pr list --state merged --limit 15 --json title --jq '.[].title'
exit: 0
tail: refactor(music): adopt authoritative snapshots and transport queues
      fix(opencode-music-player): keep controls and artwork synchronized
      feat(opencode-music-player): seek from bottom bar clicks

$ [each dispatched pr-description structural/content check]
exit: 0
tail: path exists and is not a symlink; front matter is exactly status: done;
      Conventional Commit title, two-sentence TL;DR, review table, required
      sections, exact smoke commands, and prohibited-term scan all passed.

$ test -z "$(jj diff --from eec2b96b --to @ --name-only -- .prettierignore README.md bun.lock docs packages)"
exit: 0

$ git diff --check -- . ':(exclude).apnea'
exit: 0
```

Residual risk: the description accurately limits the completed live certification to pinned pre-release hosts, one selected VLC item on macOS, and one already-running daemon generation; provider, host-version, and platform variation remain outside that coverage.
