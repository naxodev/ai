import { describe, expect, test } from "bun:test"
import { OPERATIONS } from "@naxodev/apnea"
import { PI_OPERATIONS, piHostAdapter } from "./runtime.ts"

describe("Pi host adapter", () => {
  test("binds the exact shared operation surface", () => {
    expect(PI_OPERATIONS.map(({ tool, verb }) => ({ tool, verb }))).toEqual(
      OPERATIONS.map(({ tool, verb }) => ({ tool, verb })),
    )
  })

  test("owns Pi launch preparation without changing other harnesses", () => {
    expect(piHostAdapter.beforeInteractivePrompt?.(["pi"])).toBe("/vimmode off")
    expect(piHostAdapter.beforeInteractivePrompt?.(["claude"])).toBeNull()
  })
})
