# @naxodev/pi-apnea

Pi adapter for the [Apnea workflow engine](../apnea/README.md). It registers Apnea tools, slash commands, skills, and prompts while `@naxodev/apnea` provides the shared workflow and standalone CLI.

## Install

```sh
pi install npm:@naxodev/pi-apnea
```

The normal `@naxodev/apnea` dependency installs transitively, including the `apnea` executable. Pi loads this package's `extension`, `skills`, and `prompts` resources.

Pi role panes use a dedicated `PI_CODING_AGENT_DIR` without `pi-vimmode`. The user's orchestrator session remains unchanged.

## Versioning

Compatible core patch releases flow through the `^0.1.0` dependency range. Incompatible host interface changes require coordinated minor releases of both packages.

## License

MIT. See [LICENSE](LICENSE).
