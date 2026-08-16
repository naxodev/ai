# @naxodev/pi-music-dock

A [Pi](https://github.com/earendil-works/pi) extension that shows macOS system Now Playing in the status area. It renders a calm Tokyonight-blue waveform, a clipped title and artist, and transport controls.

The extension only calls `ctx.ui.setStatus`. It does not replace Pi's footer, so it composes with the built-in footer and custom footers that render extension statuses.

## Architecture

Each live Pi TUI session owns one reconnecting music-session client and its local status, waveform, and notification lifecycle. The same-user machine-local daemon owns provider discovery, provider stream and polling, the playback clock, global transport ordering, and native media reads.

Reload and shutdown mark the old Pi session inactive, remove client listeners, stop the waveform interval, clear the status, and await client disposal. Reloading or exiting Pi does not stop a daemon that still serves OpenCode or another client.

Read the [music session architecture field guide](../../docs/music-session-architecture.html) for the shared daemon's ownership, replay, reconnect, and idle-exit behavior.

## Requirements

- macOS
- Node.js 22.19 or later
- Pi 0.83.x or 0.84.x
- [`media-control`](https://github.com/ungive/media-control), recommended:

  ```sh
  brew tap ungive/media-control
  brew install media-control
  ```

[`nowplaying-cli`](https://github.com/kirtan-shah/nowplaying-cli) is supported as a fallback. Some applications expose less reliable playback state through this fallback.

## Install

Install from npm:

```sh
pi install npm:@naxodev/pi-music-dock
```

For local development, clone the workspace and install the package directory:

```sh
git clone https://github.com/naxodev/ai.git
cd ai
bun install --frozen-lockfile
pi install ./packages/pi-music-dock
```

Restart Pi or run `/reload` after installation.

To remove the npm package:

```sh
pi remove npm:@naxodev/pi-music-dock
```

## Commands and shortcuts

| Input         | Action                  |
| ------------- | ----------------------- |
| `/music`      | Play or pause           |
| `/music-next` | Play the next track     |
| `/music-prev` | Play the previous track |
| `ctrl+alt+p`  | Play or pause           |
| `ctrl+alt+n`  | Play the next track     |
| `ctrl+alt+b`  | Play the previous track |

Slash commands are the reliable fallback when a terminal does not forward a shortcut. The status icon describes the next action: `⏸` while playing and `▶` while paused.

Shortcut constants are at the top of `extensions/music-dock/index.ts`. Edit them and run `/reload` to use different bindings.

## How it composes

`pi-music-dock` publishes one line with `ctx.ui.setStatus("music-dock", value)`. It never calls `setFooter`, so another extension may own the footer without a conflict. Its ANSI waveform avoids plain spaces because status sanitizers may collapse adjacent spaces.

## Manual verification

Automated tests cannot confirm live macOS media state or terminal rendering. Verify a release in a real Pi TUI:

1. Start playback and confirm the shared state shows the pause icon, an animated waveform, and the current title and artist.
2. Run `/music`, `/music-next`, and `/music-prev`; confirm controls and status reflect the shared daemon state.
3. Try `ctrl+alt+p`, `ctrl+alt+n`, and `ctrl+alt+b`; use the slash commands if the terminal intercepts a chord.
4. Run `/reload`; confirm one Pi client/status remains and daemon/provider ownership is not duplicated.
5. Keep another host connected, close Pi, and confirm the other host remains healthy.
6. Exit the final client; confirm the daemon can complete idle shutdown and remove its owned socket artifacts.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun packages/pi-music-dock/scripts/waveform-demo.ts
```

The package smoke packs Pi and music-core, installs exact `@earendil-works/pi-coding-agent@0.84.0` and `@earendil-works/pi-tui@0.84.0`, loads the packed extension through RPC, checks all three commands, and proves prompt process exit. Pi 0.83.x and 0.84.x remain the supported peer range. Run it on macOS because the package is macOS-only.

See the workspace [contribution guide](../../CONTRIBUTING.md) for contribution and release instructions.

## License

[MIT](LICENSE)
