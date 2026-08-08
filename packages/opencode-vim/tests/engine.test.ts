import { describe, expect, test } from "bun:test"
import { createVimState, hasPendingInput, transition } from "../engine.ts"

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

  test("saturates accumulated and multiplied counts before emitting actions", () => {
    const maximum = 999
    const accumulated = createVimState("normal")
    for (let index = 0; index < 400; index++) transition(accumulated, "9")
    expect(accumulated.pending).toEqual({ type: "none", count: maximum })
    expect(transition(accumulated, "j").actions).toEqual([
      { type: "motion", key: "j", count: maximum },
    ])

    const multiplied = createVimState("normal")
    for (const key of ["9", "9", "9", "d", "9", "9", "9"])
      transition(multiplied, key)
    const action = transition(multiplied, "w").actions[0]
    expect(action).toEqual({
      type: "operator-motion",
      operator: "delete",
      key: "w",
      count: maximum,
    })
    expect("count" in action! && Number.isFinite(action.count)).toBe(true)
  })

  test("treats a numeric count as pending input", () => {
    const state = createVimState("normal")
    expect(hasPendingInput(state)).toBe(false)
    transition(state, "2")
    expect(hasPendingInput(state)).toBe(true)
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
    expect(state.mode).toBe("visual")
  })

  test("changes complete selected lines with visual C and S", () => {
    for (const key of ["C", "S"]) {
      const state = createVimState("normal")
      transition(state, "v")

      expect(transition(state, key).actions).toEqual([
        { type: "visual-operator", operator: "change", linewise: true },
      ])
    }
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

  test("parses visual endpoint and edit commands without leaving early", () => {
    const cases = [
      ["o", { type: "visual-swap" }],
      ["p", { type: "visual-paste", preserveRegister: false, count: 1 }],
      ["P", { type: "visual-paste", preserveRegister: true, count: 1 }],
      ["J", { type: "visual-join" }],
      ["~", { type: "visual-case" }],
      [">", { type: "visual-indent", direction: "right", count: 1 }],
    ] as const
    for (const [key, action] of cases) {
      const state = createVimState("normal")
      transition(state, "v")
      expect(transition(state, key).actions).toEqual([action])
      expect(state.mode).toBe("visual")
    }

    const replace = createVimState("normal")
    transition(replace, "v")
    transition(replace, "r")
    expect(transition(replace, "x").actions).toEqual([
      { type: "visual-replace", text: "x" },
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

    const visualReturn = createVimState("normal")
    transition(visualReturn, "v")
    transition(visualReturn, "r")
    expect(transition(visualReturn, "return").actions).toEqual([])
    expect(visualReturn.mode).toBe("visual")
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

  test("uses Enter for newlines and leaves submission to the host", () => {
    const state = createVimState()
    expect(transition(state, "return").actions).toEqual([
      { type: "command", id: "input.newline" },
    ])
    expect(transition(state, "ctrl+return")).toEqual({
      consume: false,
      actions: [],
    })
    const normal = createVimState("normal")
    expect(transition(normal, "return")).toEqual({
      consume: false,
      actions: [],
    })
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

  test("Escape cancels counts, operators, and prefixes", () => {
    for (const keys of [["4"], ["2", "d", "3"], ["5", "g"]]) {
      const state = createVimState("normal")
      for (const key of keys) transition(state, key)
      expect(transition(state, "escape").actions).toEqual([])
      expect(state.pending).toEqual({ type: "none", count: 0 })
      expect(transition(state, "w").actions).toEqual([
        { type: "motion", key: "w", count: 1 },
      ])
    }
  })

  test("Ctrl+[ behaves as Escape in every mode", () => {
    const insert = createVimState()
    expect(transition(insert, "ctrl+[").actions).toEqual([
      { type: "mode", mode: "normal" },
    ])

    const normal = createVimState("normal")
    for (const key of ["2", "d", "3"]) transition(normal, key)
    expect(transition(normal, "ctrl+[").actions).toEqual([])
    expect(normal.pending).toEqual({ type: "none", count: 0 })

    const visual = createVimState("normal")
    for (const key of ["v", "2", "f"]) transition(visual, key)
    expect(transition(visual, "ctrl+[").actions).toEqual([
      { type: "mode", mode: "normal" },
    ])
    expect(visual.pending).toEqual({ type: "none", count: 0 })

    const oneShot = createVimState()
    transition(oneShot, "ctrl+o")
    expect(transition(oneShot, "ctrl+[").actions).toEqual([
      { type: "mode", mode: "insert" },
    ])
  })

  test("invalid operator and prefix completions cancel the whole command", () => {
    for (const keys of [
      ["2", "d", "3", "q"],
      ["4", "g", "q"],
    ]) {
      const state = createVimState("normal")
      for (const key of keys) transition(state, key)
      expect(state.pending).toEqual({ type: "none", count: 0 })
      expect(transition(state, "w").actions).toEqual([
        { type: "motion", key: "w", count: 1 },
      ])
    }
  })

  test("one-shot normal waits for grammar completion and completes once", () => {
    const state = createVimState()
    transition(state, "ctrl+o")
    for (const key of ["2", "d", "3", "g"]) {
      expect(transition(state, key).actions).toEqual([])
      expect(state.mode).toBe("normal")
    }
    expect(transition(state, "g").actions).toEqual([
      { type: "operator-motion", operator: "delete", key: "gg", count: 6 },
      { type: "mode", mode: "insert" },
    ])
    expect(transition(state, "w").consume).toBe(false)
  })

  test("maps host navigation and line joining", () => {
    const state = createVimState("normal")
    expect(transition(state, "/").actions).toEqual([
      { type: "command", id: "session.timeline" },
    ])
    transition(state, "3")
    expect(transition(state, "J").actions).toEqual([
      { type: "join-lines", count: 3 },
    ])
  })

  test("parses dot with an optional overriding count", () => {
    const plain = createVimState("normal")
    expect(transition(plain, ".").actions).toEqual([{ type: "repeat" }])

    const counted = createVimState("normal")
    transition(counted, "3")
    expect(transition(counted, ".").actions).toEqual([
      { type: "repeat", count: 3 },
    ])
  })

  test("preserves an insert-entry count for session replay", () => {
    const state = createVimState("normal")
    transition(state, "3")
    expect(transition(state, "o").actions).toEqual([
      { type: "enter", key: "o", count: 3 },
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
    expect(state.mode).toBe("visual")
  })

  test("parses counted character finds and their repeats", () => {
    const state = createVimState("normal")
    for (const key of ["2", "d", "3", "t"]) transition(state, key)
    expect(transition(state, ",").actions).toEqual([
      {
        type: "find",
        find: { direction: "forward", till: true, target: "," },
        count: 6,
        operator: "delete",
      },
    ])

    transition(state, "d")
    expect(transition(state, ";").actions).toEqual([
      {
        type: "find",
        find: { direction: "forward", till: true, target: "," },
        count: 1,
        operator: "delete",
        repeat: true,
      },
    ])
    expect(transition(state, ";").actions).toEqual([
      {
        type: "find",
        find: { direction: "forward", till: true, target: "," },
        count: 1,
        repeat: true,
      },
    ])
    expect(transition(state, ",").actions).toEqual([
      {
        type: "find",
        find: { direction: "backward", till: true, target: "," },
        count: 1,
        repeat: true,
      },
    ])
  })

  test("maps tab tokens for normal, operator, visual, and repeated finds", () => {
    const normal = createVimState("normal")
    transition(normal, "f")
    expect(transition(normal, "tab").actions).toEqual([
      {
        type: "find",
        find: { direction: "forward", till: false, target: "\t" },
        count: 1,
      },
    ])
    expect(transition(normal, ";").actions[0]).toMatchObject({
      type: "find",
      find: { target: "\t" },
      repeat: true,
    })

    const operator = createVimState("normal")
    for (const key of ["d", "t"]) transition(operator, key)
    expect(transition(operator, "tab").actions[0]).toMatchObject({
      type: "find",
      find: { target: "\t" },
      operator: "delete",
    })

    const visual = createVimState("normal")
    for (const key of ["v", "F"]) transition(visual, key)
    expect(transition(visual, "tab").actions[0]).toMatchObject({
      type: "find",
      find: { direction: "backward", target: "\t" },
    })
  })

  test("parses operator and visual text objects", () => {
    const operator = createVimState("normal")
    for (const key of ["2", "d", "3", "a"])
      expect(transition(operator, key).actions).toEqual([])
    expect(transition(operator, "(").actions).toEqual([
      {
        type: "text-object",
        object: "paren",
        around: true,
        count: 6,
        operator: "delete",
      },
    ])

    const visual = createVimState("normal")
    transition(visual, "v")
    transition(visual, "i")
    expect(transition(visual, '"').actions).toEqual([
      {
        type: "text-object",
        object: "double-quote",
        around: false,
        count: 1,
      },
    ])
  })

  test("distinguishes counted percent jumps from delimiter matching", () => {
    const motion = createVimState("normal")
    transition(motion, "5")
    transition(motion, "0")
    expect(transition(motion, "%").actions).toEqual([
      { type: "motion", key: "%", count: 50, percentage: true },
    ])

    const operator = createVimState("normal")
    for (const key of ["d", "5", "0"])
      expect(transition(operator, key).actions).toEqual([])
    expect(transition(operator, "%").actions).toEqual([
      {
        type: "operator-motion",
        operator: "delete",
        key: "%",
        count: 50,
        percentage: true,
      },
    ])
  })

  test("preserves counted percentage intent in visual mode", () => {
    const state = createVimState("normal")
    transition(state, "v")
    transition(state, "5")
    transition(state, "0")
    expect(transition(state, "%").actions).toEqual([
      { type: "motion", key: "%", count: 50, percentage: true },
    ])
  })

  test("repeated inner or around prefixes cancel the operator", () => {
    for (const prefix of ["i", "a"]) {
      const state = createVimState("normal")
      transition(state, "d")
      transition(state, prefix)
      expect(transition(state, prefix).actions).toEqual([])
      expect(state.pending).toEqual({ type: "none", count: 0 })
    }
  })

  test("does not enter insert mode before a change motion succeeds", () => {
    const state = createVimState("normal")
    transition(state, "c")
    expect(transition(state, "%").actions).toEqual([
      { type: "operator-motion", operator: "change", key: "%", count: 1 },
    ])
    expect(state.mode).toBe("normal")
  })
})
