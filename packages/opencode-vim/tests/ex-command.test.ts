import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode-ai/plugin/tui"
import {
  openExDialog,
  parseExCommand,
  resolveExCommand,
  type ExCommand,
} from "../ex-command.ts"

function command(
  id: string,
  name?: string,
  aliases?: string[],
  arguments_: boolean = false,
): ExCommand {
  return {
    id,
    ...(name
      ? {
          slash: {
            name,
            ...(aliases ? { aliases } : {}),
            ...(arguments_ ? { arguments: true } : {}),
          },
        }
      : {}),
    run() {},
  }
}

describe("EX command parser", () => {
  test("trims an optional colon and separates the command from its raw arguments", () => {
    expect(parseExCommand("  :review   src/a.ts --fix  ")).toEqual({
      name: "review",
      arguments: "src/a.ts --fix  ",
    })
    expect(parseExCommand("vim")).toEqual({ name: "vim", arguments: "" })
    expect(parseExCommand(":!printf '%s' hi")).toEqual({
      name: "!",
      arguments: "printf '%s' hi",
    })
  })

  test("returns no command for empty input", () => {
    expect(parseExCommand("")).toBeUndefined()
    expect(parseExCommand(" :  ")).toBeUndefined()
  })
})

describe("EX command resolver", () => {
  const commands = [
    command("session.review", "review", ["rv"]),
    command("session.rename", "rename"),
  ]

  test("prefers exact slash names and aliases over prefixes", () => {
    expect(
      resolveExCommand({ name: "rv", arguments: "raw value" }, commands),
    ).toEqual({
      type: "match",
      id: "session.review",
      arguments: "raw value",
    })
  })

  test("resolves a unique prefix and rejects an ambiguous one", () => {
    expect(resolveExCommand({ name: "rev", arguments: "" }, commands)).toEqual({
      type: "match",
      id: "session.review",
      arguments: "",
    })
    expect(
      resolveExCommand({ name: "r", arguments: "" }, commands),
    ).toMatchObject({ type: "ambiguous" })
  })

  test("rejects unknown commands", () => {
    expect(
      resolveExCommand({ name: "write", arguments: "" }, commands),
    ).toEqual({ type: "unknown" })
  })

  test("uses Vim aliases only when matching public commands exist", () => {
    const available = [
      { ...command("app.exit"), title: "Exit" },
      { ...command("command.palette.show"), palette: true as const },
      command("session.question", "question"),
    ]
    expect(resolveExCommand({ name: "q", arguments: "" }, available)).toEqual({
      type: "match",
      id: "app.exit",
      arguments: "",
    })
    expect(
      resolveExCommand({ name: "help", arguments: "" }, available),
    ).toEqual({
      type: "match",
      id: "command.palette.show",
      arguments: "",
    })
    expect(resolveExCommand({ name: "quit", arguments: "" }, [])).toEqual({
      type: "unknown",
    })
  })

  test("always rejects shell input", () => {
    const parsed = { name: "!", arguments: "echo safe" }
    expect(resolveExCommand(parsed, [command("session.shell")])).toEqual({
      type: "unsupported-shell",
    })
    expect(
      resolveExCommand(parsed, [
        command("session.shell", "shell", [], true),
        command("composer.shell", "shell", [], true),
      ]),
    ).toEqual({ type: "unsupported-shell" })
  })
})

describe("EX public adapter", () => {
  function context(input: string | undefined) {
    const dispatched: Array<[string, string | undefined]> = []
    const alerts: Array<{ title: string; message: string }> = []
    let commandsCalls = 0
    let directRuns = 0
    const commands = [
      {
        ...command("session.review", "review"),
        run() {
          directRuns++
        },
      },
    ]
    const value = {
      keymap: {
        commands() {
          commandsCalls++
          return commands
        },
        dispatch(id: string, argument?: string) {
          dispatched.push([id, argument])
        },
      },
      ui: {
        dialog: {
          async prompt() {
            return input
          },
          async alert(options: { title: string; message: string }) {
            alerts.push(options)
          },
        },
      },
    } as unknown as Pick<Plugin.Context, "keymap" | "ui">
    return {
      value,
      dispatched,
      alerts,
      commandsCalls: () => commandsCalls,
      directRuns: () => directRuns,
    }
  }

  test("dispatches the resolved ID and arguments without calling run directly", async () => {
    const adapter = context(":review src/a.ts --fix")
    await openExDialog(adapter.value)
    expect(adapter.dispatched).toEqual([["session.review", "src/a.ts --fix"]])
    expect(adapter.directRuns()).toBe(0)
    expect(adapter.alerts).toEqual([])
  })

  test("alerts for unknown and ambiguous commands", async () => {
    const unknown = context(":write")
    await openExDialog(unknown.value)
    expect(unknown.alerts[0]?.message).toBe("Unknown command: write")

    const ambiguous = context(":r")
    const original = ambiguous.value.keymap.commands
    ;(ambiguous.value.keymap as { commands: typeof original }).commands =
      () => [
        command("session.review", "review"),
        command("session.rename", "rename"),
      ]
    await openExDialog(ambiguous.value)
    expect(ambiguous.alerts[0]?.message).toStartWith("Ambiguous command: r")
    expect(ambiguous.dispatched).toEqual([])
  })

  test("cancellation and empty confirmation have no side effects", async () => {
    for (const input of [undefined, "", ":  "]) {
      const adapter = context(input)
      await openExDialog(adapter.value)
      expect(adapter.commandsCalls()).toBe(0)
      expect(adapter.dispatched).toEqual([])
      expect(adapter.alerts).toEqual([])
    }
  })
})
