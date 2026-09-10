# `@naxodev/pi-music-dock`

<p align="center">
  <img src="https://raw.githubusercontent.com/naxodev/ai/main/docs/media/pi-music-dock/card.png" alt="Pi music dock side panel playing Christian Löffler" width="360" />
</p>

[![npm](https://img.shields.io/npm/v/@naxodev/pi-music-dock)](https://www.npmjs.com/package/@naxodev/pi-music-dock)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

macOS Now Playing for [Pi](https://github.com/earendil-works/pi): a status-line dock, a solid side panel with artwork and a live waveform, and transport controls. While the agent streams, the panel collapses to a two-line chip so it never covers the transcript you are reading.

```sh
pi install npm:@naxodev/pi-music-dock
```

<p align="center">
  <img src="https://raw.githubusercontent.com/naxodev/ai/main/docs/media/pi-music-dock/footer.png" alt="Pi footer status line with waveform, title, and artist" width="640" />
</p>

## What you get

- **Status line** — play state, animated Tokyonight-blue waveform, title, and artist through `ctx.ui.setStatus`. It never replaces Pi's footer, so it composes with other extensions.
- **Side panel** — album artwork (native Kitty/iterm2/Ghostty/WezTerm/Warp rendering, with a bounded iTunes catalog fallback), metadata, waveform, progress, and keyboard hints in a 30-column card.
- **Stream-aware chip** — when the agent starts streaming, the panel hides and a compact two-line chip appears bottom-right; it expands again when the stream settles. `/music-focus` expands mid-stream on purpose.
- **Transport** — play/pause, next, previous by slash command, shortcut, or focused panel keys.

## Commands and shortcuts

| Input          | Action                                  |
| -------------- | --------------------------------------- |
| `/music`       | Play or pause                           |
| `/music-next`  | Play the next track                     |
| `/music-prev`  | Play the previous track                 |
| `/music-view`  | Toggle side panel visibility            |
| `/music-focus` | Focus the side panel for transport keys |
| `ctrl+alt+p`   | Play or pause                           |
| `ctrl+alt+n`   | Play the next track                     |
| `ctrl+alt+b`   | Play the previous track                 |
| `ctrl+alt+m`   | Toggle side panel visibility            |

After `/music-focus`: <kbd>Space</kbd> play/pause, <kbd>←</kbd>/<kbd>→</kbd> previous/next, <kbd>Esc</kbd> unfocus. The panel is `nonCapturing`, so the editor keeps normal input until you focus it.

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

## Panel behavior

- **Default:** visible on terminals 80 columns or wider, including common 82-column Herdr split panes.
- **Responsive:** auto-hides below 80 columns, leaving at least 50 columns beside the 30-column overlay.
- **Opaque card:** every row is width-padded and painted with the theme background, so transcript text cannot bleed through.
- **Overlay, not a sidebar:** Pi exposes no layout-reserving sidebar slot, so the panel is a `tui.showOverlay` approximation and can cover transcript content. The streaming chip exists so it gets out of the way exactly when you are reading.

## Architecture

Each live Pi TUI session owns **one** reconnecting music-session client and its local status, panel, waveform, artwork, and notification lifecycle. The same-user machine-local daemon owns provider discovery, the playback clock, global transport ordering, and native media reads. Reloading or exiting Pi never stops a daemon that still serves OpenCode or another client.

Read the [music session architecture field guide](https://github.com/naxodev/ai/blob/main/docs/music-session-architecture.html) for the shared daemon's ownership, replay, reconnect, and idle-exit behavior.

## Install from source

```sh
git clone https://github.com/naxodev/ai.git
cd ai
bun install --frozen-lockfile
pi install ./packages/pi-music-dock
```

Restart Pi or run `/reload` after installation. To remove: `pi remove npm:@naxodev/pi-music-dock`.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun packages/pi-music-dock/scripts/waveform-demo.ts
```

The package smoke packs Pi and music-core, installs exact `@earendil-works/pi-coding-agent@0.84.2` and `@earendil-works/pi-tui@0.84.2`, loads the packed extension through RPC, checks the registered commands, and proves prompt process exit. Run it on macOS because the package is macOS-only.

See the workspace [contribution guide](https://github.com/naxodev/ai/blob/main/CONTRIBUTING.md) for contribution and release instructions.

## License

[MIT](LICENSE)
