# @naxodev/pi-music-dock

A [Pi](https://github.com/earendil-works/pi) extension that shows macOS system Now Playing in the status area and a responsive side panel. It renders a calm Tokyonight-blue waveform, track metadata, optional native album artwork, and transport controls.

The extension calls `ctx.ui.setStatus` for the footer line. The side panel is a `tui.showOverlay` owned by an empty `setWidget` host (not `ctx.ui.custom`), so reload and shutdown dispose it synchronously without hanging on a `done()` Promise. It does not replace Pi's footer, so it composes with the built-in footer and custom footers that render extension statuses.

## Architecture

Each live Pi TUI session owns **one** reconnecting music-session client and its local status, side panel, waveform, artwork, and notification lifecycle. The same-user machine-local daemon owns provider discovery, provider stream and polling, the playback clock, global transport ordering, and native media reads.

The side panel is a **plugin-only approximation**. Pi has no layout-reserving sidebar slot, so the panel is a right-center overlay that may cover transcript content. It is not a true layout sidebar.

Reload and shutdown mark the old Pi session inactive, remove client listeners, stop the waveform interval, clear status, dispose artwork and images, hide the overlay exactly once, and await client disposal. Reloading or exiting Pi does not stop a daemon that still serves OpenCode or another client.

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

### Terminal image support

Native album artwork renders through `pi-tui` `Image` when the terminal supports Kitty, iTerm2, Ghostty, WezTerm, or Warp graphics. Other terminals, missing artwork, and unsupported image bytes show a short text placeholder. MIME type is detected locally from bounded base64 or downloaded bytes (PNG, JPEG, GIF, WebP only). The session protocol is not widened for Content-Type.

When native artwork is unavailable, too large for the daemon bound, unsupported, or fails with a provider error, the panel falls back to a **bounded exact iTunes catalog match** (same safety rules as OpenCode): HTTPS `.mzstatic.com` only, no redirects, 512KB search JSON / 3MB image caps, 4s deadlines, exact title+artist (album when present, duration ±1s). In-flight catalog work is aborted on track change, reload, and shutdown.

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

Slash commands are the reliable fallback when a terminal does not forward a shortcut. The status icon describes the next action: `⏸` while playing and `▶` while paused.

### Focused panel keys

After `/music-focus`:

| Key    | Action                          |
| ------ | ------------------------------- |
| Space  | Play or pause                   |
| Left   | Previous track                  |
| Right  | Next track                      |
| Escape | Unfocus; return input to editor |

The panel is `nonCapturing` by default, so the editor keeps normal input until you focus it.

Shortcut constants are at the top of `extensions/music-dock/index.ts`. Edit them and run `/reload` to use different bindings.

## Side panel behavior

- **Default:** visible on terminals 80 columns or wider, including common 82-column Herdr split panes.
- **Responsive:** auto-hides below 80 columns, leaving at least 50 columns beside the 30-column overlay.
- **Size:** about 30 columns wide, up to about 90% of terminal height, anchored `right-center`.
- **Content:** artwork (or placeholder), title, artist, album, animated waveform, progress/time, play state, and concise keyboard help. Every line is clipped to the panel width.
- **Overlay vs real sidebar:** this is an overlay approximation. It can cover transcript text. Pi does not currently expose a layout-reserving sidebar slot for extensions.

`/music-view` and `ctrl+alt+m` toggle user visibility. Narrow-terminal auto-hide still applies when the user has not hidden the panel.

## How it composes

`pi-music-dock` publishes one status line with `ctx.ui.setStatus("music-dock", value)`. It never calls `setFooter`, so another extension may own the footer without a conflict. Its ANSI waveform avoids plain spaces because status sanitizers may collapse adjacent spaces.

The side panel uses one `OverlayHandle` owned by the host widget. Clearing that widget key on reload or shutdown hides the handle and disposes the panel once. Transport commands and the status line stay unchanged whether the panel is visible, hidden, or focused.

## Manual verification

Automated tests cannot confirm live macOS media state or terminal rendering. Verify a release in a real Pi TUI:

1. Start playback and confirm the status line shows the pause icon, an animated waveform, and the current title and artist.
2. On a wide terminal, confirm the right-center side panel shows metadata, waveform, progress, and artwork or a placeholder.
3. Resize below 80 columns and confirm the panel auto-hides; widen again and confirm it returns.
4. Run `/music-view` and `ctrl+alt+m`; confirm toggle. Run `/music-focus`, then Space / arrows / Escape.
5. Run `/music`, `/music-next`, and `/music-prev`; confirm controls and status reflect the shared daemon state.
6. Try `ctrl+alt+p`, `ctrl+alt+n`, and `ctrl+alt+b`; use the slash commands if the terminal intercepts a chord.
7. Run `/reload`; confirm one Pi client, one overlay, and one status remain.
8. Keep another host connected, close Pi, and confirm the other host remains healthy.
9. Exit the final client; confirm the daemon can complete idle shutdown and remove its owned socket artifacts.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun packages/pi-music-dock/scripts/waveform-demo.ts
```

The package smoke packs Pi and music-core, installs exact `@earendil-works/pi-coding-agent@0.84.2` and `@earendil-works/pi-tui@0.84.2`, loads the packed extension through RPC, checks the registered commands, and proves prompt process exit. Pi 0.83.x and 0.84.x remain the supported peer range. Run it on macOS because the package is macOS-only.

See the workspace [contribution guide](../../CONTRIBUTING.md) for contribution and release instructions.

## License

[MIT](LICENSE)
