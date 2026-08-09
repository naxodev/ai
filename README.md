# AI Packages

This Nx workspace hosts focused packages for AI coding tools. Host packages publish TypeScript source because their hosts load source packages directly.

## Apnea

`@naxodev/apnea` provides the standalone CLI, workflow engine, protocol resources, Herdr integration, briefs, and schemas.

`@naxodev/pi-apnea` adapts the shared operation registry to Pi without subprocesses.

[Read the core documentation](packages/apnea/README.md) or [install the Pi adapter](packages/pi-apnea/README.md).

## OpenCode Music Player

`@naxodev/opencode-music-player` adds macOS Now Playing controls to the OpenCode 2 TUI.

[Read the package documentation](packages/opencode-music-player/README.md)

## Pi Music Dock

`@naxodev/pi-music-dock` adds macOS Now Playing status and controls to Pi.

[Read the package documentation](packages/pi-music-dock/README.md)

## Development

```sh
bun install --frozen-lockfile
bun run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development, release, and trusted publishing instructions.
