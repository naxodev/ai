# @naxodev/pi-apnea

Pi adapter for the [Apnea workflow engine](../apnea/README.md). It registers Apnea tools, slash commands, skills, and prompts while `@naxodev/apnea` provides the shared workflow and standalone CLI.

## Requirements

- Node.js 22.19 or later
- Pi 0.83.x or 0.84.x
- Bun 1.3.7 or later for the transitive `apnea` executable
- Herdr and at least one supported agent CLI, as documented by [`@naxodev/apnea`](../apnea/README.md#requirements)

## Install

```sh
pi install npm:@naxodev/pi-apnea
```

The normal `@naxodev/apnea` dependency installs transitively, including the `apnea` executable. Pi loads this package's `extension`, `skills`, and `prompts` resources.

Pi role panes use a dedicated `PI_CODING_AGENT_DIR` without `pi-vimmode`. The user's orchestrator session remains unchanged.

## Quickstart

Run these commands inside Pi:

```text
/apnea setup
/apnea start describe the implementation goal
/apnea status
```

`setup` creates global profiles in `~/.config/apnea/config.json` and links the Herdr plugin when Herdr is available. `start` begins one workflow against the current working copy. `status` reports the current step and next legal operation.

The shorter `/apnea-start` and `/apnea-status` aliases are also available. See the [Apnea CLI and operation reference](../apnea/README.md#cli-reference) for the shared command surface and exit behavior.

## Verify

Run `/apnea status` before starting a workflow. A clean installation reports no active run and identifies `workflow_start` as a legal next operation. If Pi does not register the commands, run `/reload` and inspect Pi's package-loading output.

Apnea executes repository-controlled text through configured agent CLIs and can execute planner-authored verification commands. Read the [trust model](../apnea/SECURITY.md) before using it with an untrusted repository.

## Versioning

Compatible core patch releases flow through the `^0.1.0` dependency range. Incompatible host interface changes require coordinated minor releases of both packages.

## Contributing

Use the workspace [contribution guide](../../CONTRIBUTING.md) for setup, checks, and release policy. Use [GitHub Discussions](https://github.com/naxodev/ai/discussions) for usage questions and the workspace [security policy](../../SECURITY.md) for private vulnerability reports.

## License

MIT. See [LICENSE](LICENSE).
