# AI Packages

This Nx workspace hosts a shared music core and two macOS integrations for AI coding tools. The npm packages publish TypeScript source because their hosts load source packages directly.

## Music Core

`@naxodev/music-core` provides the host-neutral media behavior used by both integrations.

[Read the package documentation](packages/music-core/README.md)

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
