# @naxodev/pi-music-dock

A [Pi](https://github.com/earendil-works/pi) extension that shows macOS system Now Playing in the status area. It renders a calm Tokyonight-blue waveform, a clipped title and artist, and transport controls.

The extension only calls `ctx.ui.setStatus`. It does not replace Pi's footer, so it composes with the built-in footer and custom footers that render extension statuses.

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

Automated tests cannot confirm the live macOS media state or terminal rendering. Verify a release in a real Pi TUI:

1. Start playback and confirm the status shows the pause icon, an animated waveform, and the current title and artist.
2. Run `/music`; confirm playback pauses, the icon changes to play, and the waveform decays to a still baseline.
3. Run `/music` again; confirm playback and waveform animation resume.
4. Run `/music-next` and `/music-prev`; confirm each command changes the track and status.
5. Try `ctrl+alt+p`, `ctrl+alt+n`, and `ctrl+alt+b`; use the slash commands if the terminal intercepts a chord.
6. Run `/reload`; confirm only one status line remains and controls still work.
7. Stop media playback; confirm the status clears on the next poll.
8. Exit Pi; confirm it shuts down promptly without a lingering process.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun packages/pi-music-dock/scripts/waveform-demo.ts
```

The workspace check includes a package smoke test that creates an npm tarball, loads that packed package through Pi's RPC mode, and verifies all three slash commands are registered. Run it on macOS because the package is macOS-only.

See the workspace [contribution guide](../../CONTRIBUTING.md) for contribution and release instructions.

## License

[MIT](LICENSE)
