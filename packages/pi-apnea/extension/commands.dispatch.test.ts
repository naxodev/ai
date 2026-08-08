import { describe, expect, test } from "bun:test"
import { OPERATIONS, type Operation } from "@naxodev/apnea"
import { registerApneaCommands } from "./commands.ts"

type Notify = (message: string, level?: "info" | "warning" | "error") => void
type Handler = (args: string, ctx: { ui: { notify: Notify } }) => Promise<void>

function stubOperations(calls: Array<{ verb: string; params: unknown }>) {
  return OPERATIONS.map((operation): Operation => ({
    ...operation,
    run: async (params) => {
      calls.push({ verb: operation.verb, params })
      return { ok: true, message: "stub" }
    },
  }))
}

function captureApneaHandler(operations: readonly Operation[]): Handler {
  let captured: Handler | undefined
  const fakePi = {
    registerCommand: (name: string, options: { handler: Handler }) => {
      if (name === "apnea") captured = options.handler
    },
    sendUserMessage: () => {},
  }
  type ExtensionAPIArg = Parameters<typeof registerApneaCommands>[0]
  registerApneaCommands(fakePi as unknown as ExtensionAPIArg, operations)
  if (!captured) throw new Error('"apnea" command was never registered')
  return captured
}

async function runAndCollect(handler: Handler, args: string) {
  const notifications: string[] = []
  await handler(args, {
    ui: { notify: (message) => notifications.push(message) },
  })
  return notifications
}

describe("registerApneaCommands registry parity", () => {
  test("every shared registry verb reaches a Pi command case", async () => {
    const calls: Array<{ verb: string; params: unknown }> = []
    const handler = captureApneaHandler(stubOperations(calls))
    for (const operation of OPERATIONS) {
      const notifications = await runAndCollect(handler, operation.verb)
      expect(
        notifications.some((message) =>
          message.startsWith("Unknown subcommand"),
        ),
      ).toBe(false)
    }
  })

  test("resume and abandon route through the shared start operation", async () => {
    const calls: Array<{ verb: string; params: unknown }> = []
    const handler = captureApneaHandler(stubOperations(calls))
    await runAndCollect(handler, "resume")
    await runAndCollect(handler, "abandon")
    expect(calls.filter(({ verb }) => verb === "start")).toHaveLength(2)
  })

  test("an unknown verb uses the Pi fallback", async () => {
    const handler = captureApneaHandler(stubOperations([]))
    const notifications = await runAndCollect(handler, "not-a-real-verb")
    expect(
      notifications.some((message) => message.startsWith("Unknown subcommand")),
    ).toBe(true)
  })

  test("Pi wait is unbounded because it has no host shell timeout", async () => {
    const calls: Array<{ verb: string; params: unknown }> = []
    const handler = captureApneaHandler(stubOperations(calls))
    await runAndCollect(handler, "wait")
    const wait = calls.find(({ verb }) => verb === "wait")
    expect((wait?.params as { budget_ms?: number }).budget_ms).toBe(
      Number.MAX_SAFE_INTEGER,
    )
  })
})
