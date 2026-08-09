import { describe, expect, test } from "bun:test"
import {
  TRANSPORT_BASELINE,
  TRANSPORT_CONTENT_WIDTH,
  TRANSPORT_LAYOUT,
  transportRowWidth,
} from "../ui.tsx"

describe("transport row width budget", () => {
  test("live row fits content width", () => {
    expect(transportRowWidth()).toBeLessThanOrEqual(TRANSPORT_CONTENT_WIDTH)
    expect(transportRowWidth(TRANSPORT_LAYOUT)).toBeLessThanOrEqual(
      TRANSPORT_CONTENT_WIDTH,
    )
  })

  test("helper math is the sum of widths and gaps", () => {
    expect(transportRowWidth(TRANSPORT_LAYOUT)).toBe(
      TRANSPORT_LAYOUT.prevWidth +
        TRANSPORT_LAYOUT.gap +
        TRANSPORT_LAYOUT.playWidth +
        TRANSPORT_LAYOUT.gap +
        TRANSPORT_LAYOUT.nextWidth,
    )
  })

  test("content width stays aligned with the package chrome constant", () => {
    expect(TRANSPORT_CONTENT_WIDTH).toBe(24)
  })

  test("baseline also fit historically", () => {
    expect(transportRowWidth(TRANSPORT_BASELINE)).toBeLessThanOrEqual(
      TRANSPORT_CONTENT_WIDTH,
    )
    expect(transportRowWidth(TRANSPORT_BASELINE)).toBe(19) // 5+1+7+1+5
  })
})

describe("play/pause primary dominance", () => {
  test("play control is wider than prev and next", () => {
    expect(TRANSPORT_LAYOUT.playWidth).toBeGreaterThan(
      TRANSPORT_LAYOUT.prevWidth,
    )
    expect(TRANSPORT_LAYOUT.playWidth).toBeGreaterThan(
      TRANSPORT_LAYOUT.nextWidth,
    )
  })

  test("prev and next stay matched so the strip stays balanced", () => {
    expect(TRANSPORT_LAYOUT.prevWidth).toBe(TRANSPORT_LAYOUT.nextWidth)
  })
})

describe("enlargement vs baseline", () => {
  test("each control is wider than the pre-change sizes", () => {
    expect(TRANSPORT_LAYOUT.prevWidth).toBeGreaterThan(
      TRANSPORT_BASELINE.prevWidth,
    )
    expect(TRANSPORT_LAYOUT.playWidth).toBeGreaterThan(
      TRANSPORT_BASELINE.playWidth,
    )
    expect(TRANSPORT_LAYOUT.nextWidth).toBeGreaterThan(
      TRANSPORT_BASELINE.nextWidth,
    )
  })

  test("hit height is taller than the pre-change single row", () => {
    expect(TRANSPORT_LAYOUT.height).toBeGreaterThan(TRANSPORT_BASELINE.height)
  })

  test("baseline records the historical 5 / 7 / 5 × h1 strip", () => {
    expect(TRANSPORT_BASELINE).toEqual({
      prevWidth: 5,
      playWidth: 7,
      nextWidth: 5,
      height: 1,
      gap: 1,
    })
  })

  test("gap stays non-negative and matches the row spacing contract", () => {
    expect(TRANSPORT_LAYOUT.gap).toBeGreaterThanOrEqual(0)
    expect(TRANSPORT_LAYOUT.gap).toBe(TRANSPORT_BASELINE.gap)
  })
})
