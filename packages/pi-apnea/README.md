# `@naxodev/pi-apnea`

[![npm](https://img.shields.io/npm/v/@naxodev/pi-apnea)](https://www.npmjs.com/package/@naxodev/pi-apnea)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Pi adapter for the [Apnea workflow engine](https://github.com/naxodev/ai/tree/main/packages/apnea). Registers Apnea tools, slash commands, skills, and prompts inside Pi while `@naxodev/apnea` provides the shared workflow engine and standalone CLI.

```sh
pi install npm:@naxodev/pi-apnea
```

Then drive the whole multi-role loop from the Pi prompt:

```text
/apnea setup
/apnea start describe the implementation goal
/apnea status
```

`setup` creates global profiles in `~/.config/apnea/config.json`. `start` begins one workflow against the current working copy. `status` reports the current step and next legal operation. The shorter `/apnea-start` and `/apnea-status` aliases are also available. See the [Apnea CLI and operation reference](https://github.com/naxodev/ai/tree/main/packages/apnea#cli-reference) for the shared command surface and exit behavior.

## What you get

- **Tools** — `workflow_start`, `dispatch_role`, `workflow_wait`, `workflow_commit_phase`, `workflow_status`, bound to the same registry as the CLI, so the two surfaces cannot drift.
- **Slash commands** — `/apnea <operation>` plus `/apnea-start` and `/apnea-status` aliases.
- **Skills and prompts** — `apnea-setup` skill and the `/apnea-init` primer, pointing at the same rules.
- **Isolated role panes** — Pi role panes run in a dedicated `PI_CODING_AGENT_DIR` without `pi-vimmode`; your orchestrator session stays unchanged.

## Requirements

- Node.js 22.19 or later
- Pi 0.83.x or 0.84.x
- Bun 1.3.7 or later for the transitive `apnea` executable
- Herdr and at least one supported agent CLI, as documented by [`@naxodev/apnea`](https://github.com/naxodev/ai/tree/main/packages/apnea#requirements)

The normal `@naxodev/apnea` dependency installs transitively, including the `apnea` executable. Pi loads this package's `extension`, `skills`, and `prompts` resources.

## Verify

Run `/apnea status` before starting a workflow. A clean installation reports no active run and identifies `workflow_start` as a legal next operation. If Pi does not register the commands, run `/reload` and inspect Pi's package-loading output.

Apnea executes repository-controlled text through configured agent CLIs and can execute planner-authored verification commands. Read the [trust model](https://github.com/naxodev/ai/blob/main/packages/apnea/SECURITY.md) before using it with an untrusted repository.

## Versioning

This incompatible adapter line requires core `^0.2.0`. Compatible core patch releases flow through that range. Future incompatible host interface changes require coordinated minor releases of both packages.

## Contributing

Use the workspace [contribution guide](https://github.com/naxodev/ai/blob/main/CONTRIBUTING.md) for setup, checks, and release policy. Use [GitHub Discussions](https://github.com/naxodev/ai/discussions) for usage questions and the workspace [security policy](https://github.com/naxodev/ai/blob/main/SECURITY.md) for private vulnerability reports.

## License

MIT. See [LICENSE](LICENSE).
