import { describe, expect, test } from "bun:test"
import {
  createTmuxOffsetCache,
  parseTmuxOffsetMessage,
  resolveTerminalOffset,
  shouldUseTmuxOffset,
  type SlotGeometry,
  type TmuxOffsetQueryResult,
} from "../tmux-offset.ts"

const slot = (
  screenX: number,
  screenY = 0,
  width = 24,
  height = 12,
): SlotGeometry => ({ screenX, screenY, width, height })

describe("shouldUseTmuxOffset", () => {
  test("false when TMUX is unset", () => {
    expect(shouldUseTmuxOffset({})).toBe(false)
    expect(shouldUseTmuxOffset({ HERDR_ENV: "1" })).toBe(false)
  })

  test("false when HERDR_ENV is set even if TMUX is set", () => {
    expect(shouldUseTmuxOffset({ TMUX: "1", HERDR_ENV: "1" })).toBe(false)
  })

  test("true when TMUX is set without HERDR_ENV", () => {
    expect(shouldUseTmuxOffset({ TMUX: "1" })).toBe(true)
    expect(shouldUseTmuxOffset({ TMUX: "/tmp/tmux-1000/default,123,0" })).toBe(
      true,
    )
  })
})

describe("parseTmuxOffsetMessage", () => {
  test("bottom status does not add a row", () => {
    expect(parseTmuxOffsetMessage("10\t2\tbottom\ton")).toEqual({
      x: 10,
      y: 2,
    })
  })

  test("top status on adds one row", () => {
    expect(parseTmuxOffsetMessage("10\t2\ttop\ton")).toEqual({ x: 10, y: 3 })
  })

  test("top status off does not add a row", () => {
    expect(parseTmuxOffsetMessage("10\t2\ttop\toff")).toEqual({ x: 10, y: 2 })
  })
})

describe("resolveTerminalOffset", () => {
  test("returns zeros without querying when TMUX is unset", () => {
    let queries = 0
    const cache = createTmuxOffsetCache()
    const offset = resolveTerminalOffset({
      env: {},
      slot: slot(5),
      cache,
      query: () => {
        queries += 1
        return { ok: true, stdout: "1\t1\tbottom\ton" }
      },
    })
    expect(offset).toEqual({ x: 0, y: 0 })
    expect(queries).toBe(0)
  })

  test("returns zeros without querying under Herdr", () => {
    let queries = 0
    const cache = createTmuxOffsetCache()
    const offset = resolveTerminalOffset({
      env: { TMUX: "1", HERDR_ENV: "1" },
      slot: slot(5),
      cache,
      query: () => {
        queries += 1
        return { ok: true, stdout: "1\t1\tbottom\ton" }
      },
    })
    expect(offset).toEqual({ x: 0, y: 0 })
    expect(queries).toBe(0)
  })

  test("busts cache when slot geometry changes", () => {
    let queries = 0
    const cache = createTmuxOffsetCache()
    const query = (): TmuxOffsetQueryResult => {
      queries += 1
      return {
        ok: true,
        stdout: queries === 1 ? "10\t2\tbottom\ton" : "20\t4\tbottom\ton",
      }
    }

    const first = resolveTerminalOffset({
      env: { TMUX: "1" },
      slot: slot(0),
      cache,
      query,
    })
    expect(first).toEqual({ x: 10, y: 2 })
    expect(queries).toBe(1)

    const second = resolveTerminalOffset({
      env: { TMUX: "1" },
      slot: slot(8), // different screenX
      cache,
      query,
    })
    expect(second).toEqual({ x: 20, y: 4 })
    expect(queries).toBe(2)
  })

  test("reuses cache for identical slot geometry", () => {
    let queries = 0
    const cache = createTmuxOffsetCache()
    const query = (): TmuxOffsetQueryResult => {
      queries += 1
      return { ok: true, stdout: "3\t1\ttop\ton" }
    }
    const geometry = slot(4, 2, 24, 12)

    const first = resolveTerminalOffset({
      env: { TMUX: "1" },
      slot: geometry,
      cache,
      query,
    })
    const second = resolveTerminalOffset({
      env: { TMUX: "1" },
      slot: { ...geometry },
      cache,
      query,
    })

    expect(first).toEqual({ x: 3, y: 2 })
    expect(second).toEqual(first)
    expect(queries).toBe(1)
  })

  test("failed query returns zeros and retries next paint", () => {
    let queries = 0
    const cache = createTmuxOffsetCache()
    const query = (): TmuxOffsetQueryResult => {
      queries += 1
      if (queries === 1) return { ok: false, stdout: "" }
      return { ok: true, stdout: "5\t0\tbottom\ton" }
    }

    const failed = resolveTerminalOffset({
      env: { TMUX: "1" },
      slot: slot(1),
      cache,
      query,
    })
    expect(failed).toEqual({ x: 0, y: 0 })

    const recovered = resolveTerminalOffset({
      env: { TMUX: "1" },
      slot: slot(1),
      cache,
      query,
    })
    expect(recovered).toEqual({ x: 5, y: 0 })
    expect(queries).toBe(2)
  })

  test("first paint with null slot still queries under tmux", () => {
    let queries = 0
    const cache = createTmuxOffsetCache()
    const offset = resolveTerminalOffset({
      env: { TMUX: "1" },
      slot: null,
      cache,
      query: () => {
        queries += 1
        return { ok: true, stdout: "1\t0\tbottom\ton" }
      },
    })
    expect(offset).toEqual({ x: 1, y: 0 })
    expect(queries).toBe(1)
  })
})
