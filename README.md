# AI Packages

This Nx workspace hosts two macOS integrations for AI coding tools. Both npm packages publish their TypeScript source because their hosts load source packages directly.

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
