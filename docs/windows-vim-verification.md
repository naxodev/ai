# Verify Vim on native Windows

Use a disposable Windows desktop account or VM with PowerShell 7, Git, Node.js with npm, Bun, and Windows Terminal. Use the workspace Bun pin and the exact host in [compatibility metadata](package-compatibility.md). Install repository dependencies with `bun install --frozen-lockfile` first. WSL is not native Windows evidence.

## Automated evidence

The Windows CI job runs unit and real-renderer lifecycle tests, the actual PowerShell clipboard provider, and an isolated install of the packed Vim plugin and supported host executable. The clipboard check writes Unicode and overlapping values, reads the real clipboard, then verifies disposal terminates the active provider and drops pending writes. It never runs on non-Windows systems.

The executable check verifies the exact native host version. It does **not** claim interactive TUI verification: hosted CI has no supported interactive desktop terminal contract. The procedure below covers modal editing, submission, reload, and exit manually. Record it separately; a green Windows CI job is not proof that these manual checks were run.

## Run the native host procedure

From the repository root in Windows Terminal using PowerShell 7:

```powershell
./packages/opencode-vim/scripts/windows-host-smoke.ps1 -Interactive
```

The script packs the current plugin, installs it with the exact supported host in a temporary consumer, and launches a private `--standalone` host. HOME and XDG directories are isolated and restored on exit. Clipboard access is disabled in this host. Record the printed host version and temporary consumer path.

1. Confirm the INSERT footer. Type `abc`, press Escape, and confirm NORMAL.
2. Press `0`, then `y`, then `l` to yank the first character. Press `x`; confirm the prompt becomes `bc`.
3. Press `v`; confirm VISUAL and a visible selection.
4. In a second PowerShell terminal, append a blank line to `node_modules/@naxodev/opencode-vim/dist/tui.js` under the printed temporary consumer. This triggers local plugin reload. Confirm VISUAL and selection remain intact.
5. Press Escape, then `u`; confirm `abc` returns. Press `p`; confirm `aabc`, proving the unnamed register survived reload.
6. Press `V`, then `C`; confirm INSERT and an empty prompt. Type `!Write-Output VIM_NATIVE_OK` and press Enter. Confirm the host executes the harmless shell command and shows its output. This uses host shell mode, not Vim's unsupported `:!` command.
7. Exit the host with its quit command. Confirm the script returns and removes the printed temporary consumer. Start it again and confirm there is only one mode footer and one response to each key.

Do not enter credentials or send a model prompt. Record terminal name/version, Windows version, host version, plugin version, each result, and any captured failure text. If a step fails, record it as failed rather than claiming overall native host support.

## Verify the native clipboard separately

This replaces the desktop clipboard. Run it only in the disposable session:

```powershell
bun packages/opencode-vim/scripts/windows-clipboard-smoke.ts --isolated-clipboard
```

Success prints `Native Windows PowerShell provider: Unicode, latest write, and disposal verified`. Provider waits have finite deadlines. The CI step also has a two-minute deadline. The smoke does not read or restore a user's previous clipboard.

The interactive host procedure is currently a reproducible manual path, not recorded automated evidence. Linux X11 clipboard verification and mocked PowerShell argument tests do not substitute for native results.
