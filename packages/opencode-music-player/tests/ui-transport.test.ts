import { describe, expect, test } from "bun:test"
import {
  COMPACT_MARKER_WIDTH,
  COMPACT_BUDGETS,
  COMPACT_SEPARATOR,
  COMPACT_TITLE_SEPARATOR,
  compactPresentation,
  compactSeekRegionWidth,
  sanitizeTerminalText,
  seekPositionForCell,
} from "../ui.tsx"

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
