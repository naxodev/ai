import { expect, test } from "bun:test"
import plugin from "../index.tsx"

test("package entrypoint exports an OpenCode TUI plugin definition", () => {
  expect(plugin.id).toBe("music-player")
  expect(plugin.setup).toBeFunction()
})
