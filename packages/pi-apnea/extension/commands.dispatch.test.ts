import { describe, expect, test } from "bun:test"
import { OPERATIONS, type ExecuteOperation } from "@naxodev/apnea"
import { registerApneaCommands } from "./commands.ts"

type Notify = (message: string, level?: "info" | "warning" | "error") => void
type Handler = (args: string, ctx: { ui: { notify: Notify } }) => Promise<void>

function captureApneaHandler(execute: ExecuteOperation): Handler {
  let captured: Handler | undefined
  const fakePi = {
    registerCommand: (name: string, options: { handler: Handler }) => {
      if (name === "apnea") captured = options.handler
    },
    sendUserMessage: () => {},
  }
  type ExtensionAPIArg = Parameters<typeof registerApneaCommands>[0]
  registerApneaCommands(
    fakePi as unknown as ExtensionAPIArg,
    OPERATIONS,
    execute,
  )
  if (!captured) throw new Error('"apnea" command was never registered')
  return captured
}

async function run(handler: Handler, args: string) {
  const notifications: Array<{ message: string; level?: string }> = []
  await handler(args, {
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
    },
  })
  return notifications
}

describe("registerApneaCommands registry parity", () => {
  test("every verb dispatches exact parameters from valid command input", async () => {
    const calls: Array<{ verb: string; params: Record<string, unknown> }> = []
    const execute: ExecuteOperation = async (verb, params) => {
      calls.push({ verb, params })
      return { ok: true, message: "stub" }
    }
    const handler = captureApneaHandler(execute)

    const fixtures = [
      {
        input: "setup --project --force --agents-md",
        verb: "setup",
        params: { project: true, force: true, agents_md: true },
      },
      {
        input: "start ship fix --allow-dirty --slug=ship-fix",
        verb: "start",
        params: {
          goal: "ship fix",
          slug: "ship-fix",
          allow_dirty: true,
          action: "start",
        },
      },
      {
        input: "dispatch plan --rework",
        verb: "dispatch",
        params: { kind: "plan", rework: true },
      },
      {
        input: "wait --poll=5000 --budget=20000",
        verb: "wait",
        params: { poll_ms: 5000, budget_ms: 20000 },
      },
      {
        input: "commit release fix --done",
        verb: "commit",
        params: { message: "release fix", no_remaining_phases: true },
      },
      { input: "status", verb: "status", params: {} },
      {
        input: "reset-rounds plan_review",
        verb: "reset-rounds",
        params: { gate: "plan_review" },
      },
    ] as const

    for (const fixture of fixtures) await run(handler, fixture.input)

    expect(calls).toEqual(
      fixtures.map(({ verb, params }) => ({ verb, params })),
    )
    expect(fixtures.map<string>(({ verb }) => verb).sort()).toEqual(
      OPERATIONS.map(({ verb }) => verb).sort(),
    )
  })

  test("resume and abandon route through start with exact actions", async () => {
    const calls: Array<{ verb: string; params: Record<string, unknown> }> = []
    const handler = captureApneaHandler(async (verb, params) => {
      calls.push({ verb, params })
      return { ok: true, message: "stub" }
    })

    await run(handler, "resume")
    await run(handler, "abandon")

    expect(calls).toEqual([
      { verb: "start", params: { goal: "", action: "resume" } },
      { verb: "start", params: { goal: "", action: "abandon" } },
    ])
  })

  test("Pi wait is unbounded because it has no host shell timeout", async () => {
    const calls: Array<{ verb: string; params: Record<string, unknown> }> = []
    const handler = captureApneaHandler(async (verb, params) => {
      calls.push({ verb, params })
      return { ok: true, message: "stub" }
    })

    await run(handler, "wait")

    expect(calls).toEqual([
      {
        verb: "wait",
        params: { poll_ms: undefined, budget_ms: Number.MAX_SAFE_INTEGER },
      },
    ])
  })

  test.each([
    "dispatch plan --rewrok",
    "wait --timeout 60000",
    "wait --budget",
    "wait --budget=",
    "status extra",
    "dispatch plan extra",
    "wait --budget=1000 --timeout=2000",
  ])("rejects invalid arguments without dispatching: %s", async (input) => {
    const calls: unknown[] = []
    const handler = captureApneaHandler(async (...args) => {
      calls.push(args)
      return { ok: true, message: "stub" }
    })

    const notifications = await run(handler, input)

    expect(calls).toEqual([])
    expect(notifications.at(-1)?.level).toBe("error")
  })

  test("supports literal goals beginning with -- after the terminator", async () => {
    const calls: Array<{ verb: string; params: Record<string, unknown> }> = []
    const handler = captureApneaHandler(async (verb, params) => {
      calls.push({ verb, params })
      return { ok: true, message: "stub" }
    })

    await run(handler, "start -- --ship safely")

    expect(calls).toEqual([
      {
        verb: "start",
        params: {
          goal: "--ship safely",
          slug: undefined,
          allow_dirty: false,
          action: "start",
        },
      },
    ])
  })
})
