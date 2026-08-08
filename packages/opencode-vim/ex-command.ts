import type { Plugin } from "@opencode-ai/plugin/tui"

type Context = Plugin.Context
export type ExCommand = ReturnType<Context["keymap"]["commands"]>[number]

export type ParsedExCommand = {
  name: string
  arguments: string
}

export type ExResolution =
  | { type: "match"; id: string; arguments: string }
  | { type: "ambiguous"; names: string[] }
  | { type: "unknown" }
  | { type: "unsupported-shell" }

export function parseExCommand(input: string): ParsedExCommand | undefined {
  let value = input.trimStart()
  if (value.startsWith(":")) value = value.slice(1).trimStart()
  if (value.trim().length === 0) return undefined

  if (value.startsWith("!")) {
    return { name: "!", arguments: value.slice(1).trimStart() }
  }

  const separator = value.search(/\s/)
  if (separator === -1) return { name: value, arguments: "" }
  return {
    name: value.slice(0, separator),
    arguments: value.slice(separator).trimStart(),
  }
}

function commandNames(command: ExCommand) {
  if (!command.id || !command.slash) return []
  return [command.slash.name, ...(command.slash.aliases ?? [])]
}

function distinctCommands(commands: readonly ExCommand[]) {
  return [...new Map(commands.map((command) => [command.id, command])).values()]
}

function matchingSlashCommands(
  name: string,
  commands: readonly ExCommand[],
  exact: boolean,
) {
  const normalized = name.toLowerCase()
  return distinctCommands(
    commands.filter((command) =>
      commandNames(command).some((candidate) =>
        exact
          ? candidate.toLowerCase() === normalized
          : candidate.toLowerCase().startsWith(normalized),
      ),
    ),
  )
}

function vimAlias(name: string, commands: readonly ExCommand[]) {
  if (name === "q" || name === "quit") {
    return commands.find(
      (command) => command.id === "app.exit" || command.id === "session.exit",
    )
  }
  if (name === "help") {
    return commands.find(
      (command) =>
        command.id === "command.palette.show" && command.palette === true,
    )
  }
  return undefined
}

export function resolveExCommand(
  parsed: ParsedExCommand,
  commands: readonly ExCommand[],
): ExResolution {
  if (parsed.name === "!") return { type: "unsupported-shell" }

  const exact = matchingSlashCommands(parsed.name, commands, true)
  if (exact.length === 1 && exact[0]?.id)
    return { type: "match", id: exact[0].id, arguments: parsed.arguments }
  if (exact.length > 1)
    return {
      type: "ambiguous",
      names: exact.flatMap(commandNames).sort(),
    }

  const alias = vimAlias(parsed.name.toLowerCase(), commands)
  if (alias?.id)
    return { type: "match", id: alias.id, arguments: parsed.arguments }

  const prefixes = matchingSlashCommands(parsed.name, commands, false)
  if (prefixes.length === 1 && prefixes[0]?.id)
    return {
      type: "match",
      id: prefixes[0].id,
      arguments: parsed.arguments,
    }
  if (prefixes.length > 1)
    return {
      type: "ambiguous",
      names: prefixes.flatMap(commandNames).sort(),
    }

  return { type: "unknown" }
}

export async function openExDialog(
  context: Pick<Context, "keymap" | "ui">,
): Promise<void> {
  const input = await context.ui.dialog.prompt({
    title: "EX command",
    description: "Run an available OpenCode slash command",
    placeholder: ":command [arguments]",
  })
  if (input === undefined) return

  const parsed = parseExCommand(input)
  if (!parsed) return

  const resolution = resolveExCommand(parsed, context.keymap.commands())
  if (resolution.type === "match") {
    context.keymap.dispatch(resolution.id, resolution.arguments)
    return
  }

  const message =
    resolution.type === "ambiguous"
      ? `Ambiguous command: ${parsed.name} (${resolution.names.join(", ")})`
      : resolution.type === "unsupported-shell"
        ? "Shell commands are unsupported by this plugin."
        : `Unknown command: ${parsed.name}`
  await context.ui.dialog.alert({ title: "EX command", message })
}
