# Security

Apnea runs an automated loop that executes repo-controlled text through agent CLIs. That is a
real trust boundary, not an incidental detail, and it is worth stating plainly before you point
this tool at a repository.

## Trust model

- **Repo-controlled argv is not allowed.** Profiles and every `cmd_*` array resolve only from
  `~/.config/apnea/config.json` plus package defaults. A project-local `.apnea/config.json`
  that sets `cmd`, `cmd_oneshot`, `cmd_interactive`, or `bin` hard-errors at start. Project
  config may only rebind roles to profile names that already exist, and set caps and timeouts.
- **Repo-controlled text is an accepted prompt-injection surface.** Tasks, plans, verify
  commands, and vendored briefs are all repo text that reaches an agent CLI. This is
  **disclosed, not solved.** Running Apnea over a repository you do not trust hands that
  repository's text to an agent running with your credentials.
- **Planner-authored verify commands execute at the commit gate**, in the project working
  directory, in the same trust domain as the coder writing source. Their output goes to
  `verify.log`.
- **Git phase commits bypass hooks by design.** Apnea stages into an isolated index, writes and
  validates the exact tree, creates it with `commit-tree`, then compare-and-swaps the branch ref.
  Running hooks after validation would let them change the committed tree. Apnea preserves
  `commit.gpgsign=true` by asking `commit-tree` to sign, but it does not run commit-msg,
  pre-commit, or post-commit policy hooks. The validated tree is written to the real index before
  the ref moves, so index failure cannot advance the branch. An unrelated external Git process can
  still race that real-index replacement; the repository lock coordinates Apnea processes, not
  arbitrary Git clients.
- **Repository locks identify owners by PID plus a random token.** The token prevents one owner
  from deleting a replacement lock. Apnea never reclaims dead or malformed locks automatically:
  it reports the validated lock path and requires manual cleanup after the user verifies no owner
  remains. PID reuse can keep a dead lock looking live because there is no portable
  process-creation identity across supported platforms; this also fails closed. Global setup waits
  only when the recorded PID is currently live; it never retries stale or malformed ownership.
- **Setup serializes account-global configuration and role resources.** Every setup holds one
  same-user lock keyed by the canonical account home for its full read/merge/write and role-agent
  materialization. Setup takes this global lock before an optional repository lock. Global config
  replacement is atomic, rejects symlink components, and fsyncs the file and parent directory
  where the platform supports it.
- **Project-path checks reject existing symlink components but cannot provide `openat` semantics.**
  Node does not expose a portable directory-descriptor traversal API, so a hostile same-user
  process can still race a checked parent component before the final filesystem operation.

See [`docs/protocol/config.md`](docs/protocol/config.md) (Trust model section) and
[`docs/adr/0006-config-trust-model.md`](docs/adr/0006-config-trust-model.md) for the full
rationale.

## Supported versions

The package is pre-1.0. Only the latest release receives fixes.

## Reporting a vulnerability

Please report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/naxodev/ai/security) on
`naxodev/ai` - open the repository's Security tab and select "Report a vulnerability".

Do not open a public issue for a security report.
