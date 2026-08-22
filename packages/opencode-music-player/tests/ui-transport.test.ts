import { describe, expect, test } from "bun:test"
import {
  TRANSPORT_BASELINE,
  TRANSPORT_CONTENT_WIDTH,
  TRANSPORT_LAYOUT,
  COMPACT_MARKER_WIDTH,
  COMPACT_BUDGETS,
  COMPACT_SEPARATOR,
  COMPACT_TITLE_SEPARATOR,
  compactPresentation,
  compactSeekRegionWidth,
  sanitizeTerminalText,
  seekPositionForCell,
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

describe("compact row width policy", () => {
  const title = "A deliberately long current track title"
  const artist = "A deliberately long artist name"

  const renderedWidth = (result: ReturnType<typeof compactPresentation>) =>
    COMPACT_MARKER_WIDTH +
    result.padding * 2 +
    (result.title
      ? COMPACT_TITLE_SEPARATOR.length + Bun.stringWidth(result.title)
      : 0) +
    (result.artist
      ? COMPACT_SEPARATOR.length + Bun.stringWidth(result.artist)
      : 0)

  test("wide budget includes padding, separators, title, and artist", () => {
    const width = COMPACT_BUDGETS.wide.minWidth
    const result = compactPresentation(width, title, artist, true)
    expect(result.tier).toBe("wide")
    expect(result.artist).toMatch(/…$/)
    expect(renderedWidth(result)).toBeLessThanOrEqual(width)
  })

  test("one cell below wide omits artist before reducing the title budget", () => {
    const result = compactPresentation(
      COMPACT_BUDGETS.wide.minWidth - 1,
      title,
      artist,
      false,
    )
    expect(result.tier).toBe("medium")
    expect(result.artist).toBeNull()
    expect(Bun.stringWidth(result.title!)).toBe(
      COMPACT_BUDGETS.medium.titleWidth,
    )
    expect(renderedWidth(result)).toBeLessThanOrEqual(
      COMPACT_BUDGETS.wide.minWidth - 1,
    )
  })

  test("medium starts at its exact declared boundary", () => {
    const width = COMPACT_BUDGETS.medium.minWidth
    const result = compactPresentation(width, title, artist, true)
    expect(result.tier).toBe("medium")
    expect(result.artist).toBeNull()
    expect(result.title).toMatch(/…$/)
    expect(renderedWidth(result)).toBeLessThanOrEqual(width)
  })

  test("one cell below medium uses the remaining narrow title budget", () => {
    const width = COMPACT_BUDGETS.medium.minWidth - 1
    const result = compactPresentation(width, title, artist, true)
    expect(result.tier).toBe("narrow")
    expect(renderedWidth(result)).toBeLessThanOrEqual(width)
  })

  test("narrow starts exactly where marker, padding, separator, and title fit", () => {
    const width = COMPACT_BUDGETS.narrow.minWidth
    const result = compactPresentation(width, title, artist, true)
    expect(result).toMatchObject({ tier: "narrow", title: "A…", artist: null })
    expect(renderedWidth(result)).toBe(width)
  })

  test("one cell below narrow keeps only the playback marker", () => {
    expect(
      compactPresentation(
        COMPACT_BUDGETS.narrow.minWidth - 1,
        title,
        artist,
        false,
      ),
    ).toEqual({
      tier: "markerOnly",
      marker: expect.any(String),
      padding: 0,
      title: null,
      artist: null,
    })
  })

  test("sanitizes controls and whitespace before deterministic truncation", () => {
    const first = compactPresentation(
      10,
      "  Long\n\u001b[31m  title  ",
      "artist",
      true,
    )
    const second = compactPresentation(
      10,
      "Long \u001b[31m title",
      "artist",
      true,
    )
    expect(first).toEqual(second)
    expect(first.title).toBe("Long …")
    expect(renderedWidth(first)).toBeLessThanOrEqual(10)
  })

  test("removes terminal control sequences from sidebar metadata and errors", () => {
    expect(
      sanitizeTerminalText("Café 🎵\u001b]52;c;YXR0YWNr\u0007\u001b[31m\nnext"),
    ).toBe("Café 🎵 next")
  })

  test("uses a stable fallback for an empty title and omits an empty artist", () => {
    const result = compactPresentation(
      COMPACT_BUDGETS.wide.minWidth,
      " \n ",
      "\t",
      false,
    )
    expect(result).toMatchObject({ title: "Unknown track", artist: null })
    expect(renderedWidth(result)).toBeLessThanOrEqual(
      COMPACT_BUDGETS.wide.minWidth,
    )
  })
})

describe("compact seek geometry", () => {
  test("reserves approximately eighty percent for seeking", () => {
    expect(compactSeekRegionWidth(100)).toBe(80)
    expect(compactSeekRegionWidth(55)).toBe(44)
    expect(compactSeekRegionWidth(10)).toBe(8)
  })

  test("maps the first, middle, and final cells across the duration", () => {
    expect(seekPositionForCell(0, 11, 100_000)).toBe(0)
    expect(seekPositionForCell(5, 11, 100_000)).toBe(50_000)
    expect(seekPositionForCell(10, 11, 100_000)).toBe(100_000)
  })

  test("clamps click positions to the track bounds", () => {
    expect(seekPositionForCell(-20, 11, 100_000)).toBe(0)
    expect(seekPositionForCell(40, 11, 100_000)).toBe(100_000)
  })

  test("rejects unavailable durations and widths", () => {
    expect(seekPositionForCell(2, 10, 0)).toBeNull()
    expect(seekPositionForCell(2, 10, -1)).toBeNull()
    expect(seekPositionForCell(2, 10, Number.NaN)).toBeNull()
    expect(seekPositionForCell(2, 0, 100_000)).toBeNull()
    expect(seekPositionForCell(0, 1, 100_000)).toBe(0)
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
