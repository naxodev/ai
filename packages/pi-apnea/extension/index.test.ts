import { describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import registerExtension, { registerApneaTools } from "./index.ts"
import { PI_OPERATIONS } from "./runtime.ts"

describe("Pi extension tool registration", () => {
  test("registers every model tool as sequential", () => {
    const tools: Array<{ name: string; executionMode?: string }> = []
    const pi = {
      registerCommand: () => {},
      registerTool: (tool: { name: string; executionMode?: string }) => {
        tools.push(tool)
      },
      sendUserMessage: () => {},
    }

    registerExtension(pi as unknown as ExtensionAPI)

    expect(tools.map(({ name }) => name)).toEqual(
      PI_OPERATIONS.flatMap(({ tool }) => (tool === null ? [] : [tool])),
    )
    expect(
      tools.every(({ executionMode }) => executionMode === "sequential"),
    ).toBe(true)
  })

  test("passes the Pi tool signal to commit and dispatch", async () => {
    type ExecuteTool = (
      id: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<unknown>
    const tools = new Map<string, ExecuteTool>()
    const pi = {
      registerTool: (tool: { name: string; execute: ExecuteTool }) =>
        tools.set(tool.name, tool.execute),
    }
    const calls: Array<{ verb: string; signal?: AbortSignal }> = []
    registerApneaTools(
      pi as unknown as ExtensionAPI,
      PI_OPERATIONS,
      async (verb, _params, hooks) => {
        calls.push({ verb, signal: hooks?.signal })
        return { ok: true, message: "ok" }
      },
    )
    const controller = new AbortController()

    await tools.get("workflow_commit_phase")?.("commit", {}, controller.signal)
    await tools.get("dispatch_role")?.(
      "dispatch",
      { kind: "plan" },
      controller.signal,
    )

    expect(calls).toEqual([
      { verb: "commit", signal: controller.signal },
      { verb: "dispatch", signal: controller.signal },
    ])
  })
})
