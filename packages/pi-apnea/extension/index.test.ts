import { describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import registerExtension from "./index.ts"
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
})
