import { expect, test } from "bun:test"
import { minimumBun } from "./minimum-bun.ts"

test("minimum checks select the declared lower bound rather than the installed toolchain", () => {
  expect(minimumBun(">=1.3.0")).toBe("1.3.0")
  expect(minimumBun(">=1.3.7")).toBe("1.3.7")
  expect(() => minimumBun("^1.3.0 || >=2")).toThrow("Unsupported")
})
