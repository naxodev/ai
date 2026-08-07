import { describe, expect, test } from "bun:test"
import { emptyPlayer, formatMs } from "../types.ts"

describe("formatMs", () => {
  test.each([
    [-1, "0:00"],
    [999, "0:00"],
    [61_999, "1:01"],
    [3_600_000, "60:00"],
  ])("formats %d milliseconds as %s", (milliseconds, expected) => {
    expect(formatMs(milliseconds)).toBe(expected)
  })
})

test("emptyPlayer returns independent timestamps", () => {
  const before = Date.now()
  const player = emptyPlayer()

  expect(player).toMatchObject({
    is_playing: false,
    progress_ms: 0,
    device: null,
    track: null,
  })
  expect(player.fetched_at).toBeGreaterThanOrEqual(before)
})
