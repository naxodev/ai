# OpenCode V2 API Findings

These findings target stable `opencode v2.0.3`. Recheck them when updating
the pinned OpenCode dependencies.

## Package Loading

- TUI plugins are configured through the global `~/.config/opencode/cli.json`.
- A package must expose `./tui`. Workspace tests check the root export with
  exact development dependencies; standalone consumer loading is unsupported.
- The npm `./tui` export resolves to `dist/tui.js`. Build and configure the absolute
  `dist` directory for local development. The stable local loader resolves the
  `tui` basename rather than package exports and ignores single-file paths.
- JSX is precompiled because the host cannot resolve a source JSX pragma without
  an installed OpenTUI package. Every package import remains external so the host
  supplies one renderer and Solid runtime. Packed smokes verify name loading and reload.

## EX Command Bridge

- `context.keymap.commands()` exposes reachable commands, including slash names
  and aliases.
- `context.keymap.dispatch(id, input)` is the public command dispatch seam and
  accepts raw command input.
- `context.ui.dialog.prompt()` returns only a string or cancellation. It does not
  expose whether confirmation came from a typed Enter or a pasted newline.
- The EX adapter resolves only commands returned by `commands()` and dispatches
  their IDs. It does not call command `run` functions directly.
- `:!` is always rejected. Do not synthesize prompt submissions or route shell
  text through another command. Vim file commands such as `:w` have no honest
  prompt-editor meaning.

## Insert Transactions

- `EditBufferRenderable` exposes public text, cursor, and selection state.
- OpenTUI `0.5.10` clears selection when assigning `cursorOffset`. Move the
  cursor before setting selection, including visual remount and operator motions.
- It also exposes one `onContentChange` callback property, not a composable event
  subscription. Replacing that callback would risk conflicting with the host.
- Insert transactions should therefore snapshot public editor state on entry
  and compare it on exit instead of intercepting printable input or replacing
  the host callback.

## Clipboard Security

- Clipboard providers are a fixed allowlist. Configuration never accepts an
  arbitrary command, arguments, or shell fragment.
- Providers are spawned directly with fixed argument arrays and `shell: false`.
  Yank text is written unchanged as UTF-8 on standard input.
- The Windows `clip` option invokes a fixed PowerShell `Set-Clipboard` script so
  non-ASCII text does not depend on the active OEM code page.
- Provider processes are terminated after two seconds and during plugin cleanup.
- Availability and process failures must remain outside the editing path. They
  may produce one public UI warning but cannot change register or editor state.
