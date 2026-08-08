# @naxodev/opencode-vim

Native Vim-style modal prompt editing for the OpenCode 2 TUI.

> [!IMPORTANT]
> This package is tested with exactly `opencode2 v0.0.0-next-17020` and matching `@opencode-ai/plugin` and `@opencode-ai/theme` packages. The OpenCode V2 TUI plugin API is beta and may change before its stable release.

## Requirements

- OpenCode 2 `v0.0.0-next-17020`
- Bun, which OpenCode uses to load TypeScript plugin packages
- macOS for copying yanks to the system clipboard through `pbcopy`

## Install

Add the npm package to `plugins` in the global `~/.config/opencode/cli.json`:

```jsonc
{
  "plugins": ["@naxodev/opencode-vim"],
}
```

OpenCode installs the package and its production dependencies in an isolated cache. Restart OpenCode after changing the package entry.

To start in normal mode, use the object form:

```jsonc
{
  "plugins": [
    {
      "package": "@naxodev/opencode-vim",
      "options": { "startMode": "normal" },
    },
  ],
}
```

## Options

| Option      | Values                 | Default  | Purpose                      |
| ----------- | ---------------------- | -------- | ---------------------------- |
| `startMode` | `"insert"`, `"normal"` | `insert` | Select the initial Vim mode. |

Use `/vim` or the command palette action **Toggle Vim mode** to persistently enable or disable modal editing.

## Key Reference

| Keys                    | Action                                          |
| ----------------------- | ----------------------------------------------- |
| `escape`, `ctrl+[`      | Enter normal mode                               |
| `i`, `a`, `A`, `I`      | Enter insert mode                               |
| `o`, `O`                | Open a line and enter insert mode               |
| `ctrl+o`                | Run one normal-mode command from insert mode    |
| `h`, `j`, `k`, `l`      | Move left, down, up, or right                   |
| `w`, `b`, `e`           | Move by words                                   |
| `0`, `^`, `$`           | Move within the current line                    |
| `gg`, `G`               | Move to the first or last line                  |
| digits                  | Prefix a motion or operation with a count       |
| `d`, `c`, `y` + motion  | Delete, change, or yank by motion               |
| `dd`, `cc`, `yy`        | Delete, change, or yank complete lines          |
| `x`, `X`, `D`, `C`      | Delete characters or to the end of the line     |
| `p`, `P`                | Paste after or before                           |
| `r` + character         | Replace characters                              |
| `v`, `V`                | Enter character or line visual mode             |
| `u`, `ctrl+r`           | Undo or redo one Vim command                    |
| `J`                     | Join lines                                      |
| `return`, `ctrl+return` | Submit in normal mode; newline or submit insert |
| `:`                     | Open the command palette                        |
| `/`                     | Open the session timeline                       |
| `[`, `]`                | Move the session view by half a page            |
| `{`, `}`                | Select the previous or next session message     |
| `j`, `k` on empty input | Select the next or previous prompt history item |

Yanks also update the macOS system clipboard.

## Limitations

- The public V2 keymap API cannot intercept arbitrary printable Unicode. An unlisted Unicode key may reach the editor in normal or visual mode.
- Active leader prefixes are left to OpenCode. The API does not expose inactive or dynamically changed leader configuration.
- Clipboard integration uses macOS `pbcopy`. Modal editing still works on other platforms, but clipboard writes do not.
- This is prompt editing, not full Vim emulation. Only the commands listed above are implemented.

## Verify

Start OpenCode and confirm the prompt footer shows the active mode:

```text
-- INSERT --
```

Use `/vim` to toggle the footer between the active mode and `VIM OFF`. If the footer does not appear, inspect `~/.local/share/opencode/log/opencode.log`. The server `/api/plugin` endpoint does not report client-only TUI plugins.

## Development

```sh
bun install --frozen-lockfile
bun run validate
```

`validate` checks formatting and types, runs tests, verifies the tarball, and imports the installed tarball from an isolated consumer.

## Attribution

The transition-engine design was informed by [`oribarilan/vimcode`](https://github.com/oribarilan/vimcode). This native V2 implementation preserves that project's license in [LICENSE.vimcode](LICENSE.vimcode).

## License

[MIT](LICENSE)
