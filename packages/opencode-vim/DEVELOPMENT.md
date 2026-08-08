# OpenCode V2 API Findings

These findings target `opencode2 v0.0.0-next-17020`. Recheck them when updating
the pinned OpenCode dependencies.

## Package Loading

- TUI plugins are configured through the global `~/.config/opencode/cli.json`.
- A package must expose `./tui`. A root export alone imports in a Bun consumer
  but is not a valid TUI package entrypoint.
- The npm `./tui` export resolves to `tui.tsx`. For local development on this
  release, configure the absolute `tui.tsx` path because a configured package
  directory probes a literal `tui` path before package export resolution.
- OpenCode loads the TSX source entrypoint directly. The packed-consumer smoke
  test verifies the same export after an isolated installation.

## EX Command Bridge

- `context.keymap.commands()` exposes reachable commands, including slash names
  and aliases.
- `context.keymap.dispatch(id, input)` is the public command dispatch seam and
  accepts raw command input.
- `context.ui.dialog.prompt()` returns only a string or cancellation. It does not
  expose whether confirmation came from a typed Enter or a pasted newline.
- Safe paste handling and a public OpenCode shell route remain unresolved. Do
  not synthesize prompt submissions or spawn shell commands as a fallback.

## Insert Transactions

- `EditBufferRenderable` exposes public text, cursor, and selection state.
- It also exposes one `onContentChange` callback property, not a composable event
  subscription. Replacing that callback would risk conflicting with the host.
- Insert transactions should therefore snapshot public editor state on entry
  and compare it on exit instead of intercepting printable input or replacing
  the host callback.
