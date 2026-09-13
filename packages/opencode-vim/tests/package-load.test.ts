import { expect, test } from "bun:test"
import plugin from "../index.tsx"
import tuiPlugin from "../tui.tsx"

test("package entrypoint exports the Vim TUI plugin definition", () => {
  expect(plugin.id).toBe("vimcode-v2")
  expect(plugin.setup).toBeFunction()
  expect(tuiPlugin).toBe(plugin)
})
