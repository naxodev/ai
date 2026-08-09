import { describe, expect, test } from "bun:test"
import { formatMs } from "../format.ts"

describe("formatMs", () => {
  // Progress/duration display must be m:ss and clamp negatives.
  test("formats seconds and clamps negatives to 0:00", () => {
    expect(formatMs(65_000)).toBe("1:05")
    expect(formatMs(-1)).toBe("0:00")
  })

  // OpenCode table: sub-second floors, minute boundary, hour-as-minutes.
  test.each([
    [-1, "0:00"],
    [999, "0:00"],
    [61_999, "1:01"],
    [3_600_000, "60:00"],
  ])("formats %d milliseconds as %s", (milliseconds, expected) => {
    expect(formatMs(milliseconds)).toBe(expected)
  })
})
