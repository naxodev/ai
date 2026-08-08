import { describe, expect, test } from "bun:test"
import { createVimState, transition } from "../engine.ts"

describe("vim transition engine", () => {
  test("leaves insert mode without consuming ordinary insert input", () => {
    const state = createVimState()
    expect(transition(state, "a").consume).toBe(false)
    expect(transition(state, "escape").actions).toEqual([
      { type: "mode", mode: "normal" },
    ])
    expect(state.mode).toBe("normal")
  })

  test("multiplies operator and motion counts", () => {
    const state = createVimState("normal")
    for (const key of ["2", "d", "3", "w"]) transition(state, key)
    expect(transition(createVimState("normal"), "escape").consume).toBe(true)
    const replay = createVimState("normal")
    transition(replay, "2")
    transition(replay, "d")
    transition(replay, "3")
    expect(transition(replay, "w").actions).toEqual([
      { type: "operator-motion", operator: "delete", key: "w", count: 6 },
    ])
  })

  test("supports line operators and change mode transitions", () => {
    const state = createVimState("normal")
    transition(state, "3")
    transition(state, "c")
    const result = transition(state, "c")
    expect(result.actions).toEqual([
      { type: "operator-line", operator: "change", count: 3 },
    ])
  })

  test("enters visual mode and applies an operator to the selection", () => {
    const state = createVimState("normal")
    transition(state, "v")
    expect(state.mode).toBe("visual")
    expect(transition(state, "y").actions).toEqual([
      { type: "visual-operator", operator: "yank", linewise: false },
    ])
    expect(state.mode).toBe("normal")
  })

  test("preserves linewise visual intent and supports visual gg", () => {
    const linewise = createVimState("normal")
    transition(linewise, "V")
    expect(transition(linewise, "d").actions).toEqual([
      { type: "visual-operator", operator: "delete", linewise: true },
    ])

    const characterwise = createVimState("normal")
    transition(characterwise, "v")
    transition(characterwise, "g")
    expect(transition(characterwise, "g").actions).toEqual([
      { type: "motion", key: "gg", count: 1 },
    ])
  })

  test("resolves gg and replace prefixes", () => {
    const state = createVimState("normal")
    transition(state, "g")
    expect(transition(state, "g").actions).toEqual([
      { type: "motion", key: "gg", count: 1 },
    ])
    transition(state, "4")
    transition(state, "r")
    expect(transition(state, "z").actions).toEqual([
      { type: "replace", text: "z", count: 4 },
    ])
  })

  test("cancels replace with Escape and maps key tokens to text", () => {
    const cancelled = createVimState("normal")
    transition(cancelled, "r")
    expect(transition(cancelled, "escape").actions).toEqual([])

    const space = createVimState("normal")
    transition(space, "r")
    expect(transition(space, "space").actions).toEqual([
      { type: "replace", text: " ", count: 1 },
    ])
  })

  test("keeps an operator pending through g so dgg/cgg/ygg work", () => {
    for (const [operatorKey, operator] of [
      ["d", "delete"],
      ["c", "change"],
      ["y", "yank"],
    ] as const) {
      const state = createVimState("normal")
      transition(state, operatorKey)
      transition(state, "g")
      expect(transition(state, "g").actions[0]).toEqual({
        type: "operator-motion",
        operator,
        key: "gg",
        count: 1,
      })
    }
  })

  test("returns to insert after one complete Ctrl+O command", () => {
    const state = createVimState()
    expect(transition(state, "ctrl+o").actions).toEqual([
      { type: "mode", mode: "normal", oneShot: true },
    ])
    transition(state, "2")
    expect(state.mode).toBe("normal")
    expect(transition(state, "w").actions).toEqual([
      { type: "motion", key: "w", count: 2 },
      { type: "mode", mode: "insert" },
    ])
    expect(state.mode).toBe("insert")
  })

  test("uses Enter for newlines and Ctrl+Enter for submission", () => {
    const state = createVimState()
    expect(transition(state, "return").actions).toEqual([
      { type: "command", id: "input.newline" },
    ])
    expect(transition(state, "ctrl+return").actions).toEqual([
      { type: "submit" },
    ])
  })

  test("keeps one-shot normal active while an operator is pending", () => {
    const state = createVimState()
    transition(state, "ctrl+o")
    expect(transition(state, "d").actions).toEqual([])
    expect(state.mode).toBe("normal")
    expect(transition(state, "w").actions).toEqual([
      { type: "operator-motion", operator: "delete", key: "w", count: 1 },
      { type: "mode", mode: "insert" },
    ])
  })

  test("maps host navigation and line joining", () => {
    const state = createVimState("normal")
    expect(transition(state, "/").actions).toEqual([
      { type: "command", id: "session.timeline" },
    ])
    transition(state, "3")
    expect(transition(state, "J").actions).toEqual([
      { type: "join-lines", count: 2 },
    ])
  })

  test("returns to insert after a one-shot visual operation", () => {
    const state = createVimState()
    transition(state, "ctrl+o")
    transition(state, "v")
    expect(state.mode).toBe("visual")
    expect(transition(state, "y").actions).toEqual([
      { type: "visual-operator", operator: "yank", linewise: false },
    ])
    expect(state.mode).toBe("insert")
  })
})
