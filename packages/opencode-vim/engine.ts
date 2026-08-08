export type VimMode = "insert" | "normal" | "visual"
export type Operator = "delete" | "change" | "yank"
export type MotionKey =
  "h" | "j" | "k" | "l" | "w" | "b" | "e" | "0" | "^" | "$" | "G" | "gg"
export type EnterKey = "i" | "a" | "A" | "I" | "o" | "O"

const enterKeys = new Set<EnterKey>(["i", "a", "A", "I", "o", "O"])

function isEnterKey(key: string): key is EnterKey {
  return enterKeys.has(key as EnterKey)
}

export type VimState = {
  mode: VimMode
  oneShotNormal: boolean
  count: number
  operator: Operator | null
  operatorCount: number
  prefix: "g" | "replace" | null
  lineVisual: boolean
}

export type VimAction =
  | { type: "motion"; key: MotionKey; count: number }
  | {
      type: "operator-motion"
      operator: Operator
      key: MotionKey
      count: number
    }
  | { type: "operator-line"; operator: Operator; count: number }
  | { type: "enter"; key: EnterKey }
  | { type: "mode"; mode: VimMode; linewise?: boolean; oneShot?: boolean }
  | { type: "delete-char"; backward: boolean; count: number }
  | { type: "paste"; before: boolean; count: number }
  | { type: "replace"; text: string; count: number }
  | { type: "visual-operator"; operator: Operator; linewise: boolean }
  | { type: "command"; id: string }
  | { type: "join-lines"; count: number }
  | { type: "undo" | "redo" | "submit" | "palette" }

export type Transition = { consume: boolean; actions: VimAction[] }

const motions = new Set<MotionKey>([
  "h",
  "j",
  "k",
  "l",
  "w",
  "b",
  "e",
  "0",
  "^",
  "$",
  "G",
])

function isMotionKey(key: string): key is MotionKey {
  return motions.has(key as MotionKey)
}

export function createVimState(startMode: VimMode = "insert"): VimState {
  return {
    mode: startMode,
    oneShotNormal: false,
    count: 0,
    operator: null,
    operatorCount: 0,
    prefix: null,
    lineVisual: false,
  }
}

function takeCount(state: VimState): number {
  const count = state.count || 1
  state.count = 0
  return count
}

function clearPending(state: VimState) {
  state.count = 0
  state.operator = null
  state.operatorCount = 0
  state.prefix = null
}

function setMode(state: VimState, mode: VimMode) {
  clearPending(state)
  state.mode = mode
  state.oneShotNormal = false
  state.lineVisual = false
}

function operatorFor(key: string): Operator | null {
  if (key === "d") return "delete"
  if (key === "c") return "change"
  if (key === "y") return "yank"
  return null
}

export function transition(state: VimState, key: string): Transition {
  if (state.mode === "insert") {
    if (key === "return") {
      return {
        consume: true,
        actions: [{ type: "command", id: "input.newline" }],
      }
    }
    if (key === "ctrl+return") {
      return { consume: true, actions: [{ type: "submit" }] }
    }
    if (key === "ctrl+o") {
      clearPending(state)
      state.mode = "normal"
      state.oneShotNormal = true
      return {
        consume: true,
        actions: [{ type: "mode", mode: "normal", oneShot: true }],
      }
    }
    if (key !== "escape" && key !== "ctrl+[")
      return { consume: false, actions: [] }
    setMode(state, "normal")
    return { consume: true, actions: [{ type: "mode", mode: "normal" }] }
  }

  if (state.mode === "visual") return transitionVisual(state, key)
  const result = transitionNormal(state, key)
  if (
    state.oneShotNormal &&
    result.consume &&
    state.mode === "normal" &&
    state.count === 0 &&
    state.operator === null &&
    state.prefix === null
  ) {
    state.mode = "insert"
    state.oneShotNormal = false
    result.actions.push({ type: "mode", mode: "insert" })
  }
  return result
}

function transitionNormal(state: VimState, key: string): Transition {
  if (key === "escape") {
    if (state.oneShotNormal) {
      state.mode = "insert"
      state.oneShotNormal = false
      clearPending(state)
      return { consume: true, actions: [{ type: "mode", mode: "insert" }] }
    }
    clearPending(state)
    return { consume: true, actions: [] }
  }

  if (state.prefix === "replace") {
    const count = takeCount(state)
    state.prefix = null
    if (key === "escape") return { consume: true, actions: [] }
    const replacement =
      key === "space"
        ? " "
        : key === "tab"
          ? "\t"
          : key === "return"
            ? "\n"
            : [...key].length === 1 && !/^\p{Cc}$/u.test(key)
              ? key
              : null
    return replacement === null
      ? { consume: true, actions: [] }
      : {
          consume: true,
          actions: [{ type: "replace", text: replacement, count }],
        }
  }

  if (state.prefix === "g") {
    state.prefix = null
    const count = takeCount(state)
    if (key === "g") {
      if (state.operator) {
        const operator = state.operator
        const operatorCount = state.operatorCount
        clearPending(state)
        if (operator === "change") setMode(state, "insert")
        return {
          consume: true,
          actions: [
            {
              type: "operator-motion",
              operator,
              key: "gg",
              count: operatorCount * count,
            },
          ],
        }
      }
      return { consume: true, actions: [{ type: "motion", key: "gg", count }] }
    }
    clearPending(state)
    return { consume: true, actions: [] }
  }

  if (/^[1-9]$/.test(key) || (key === "0" && state.count > 0)) {
    state.count = state.count * 10 + Number(key)
    return { consume: true, actions: [] }
  }

  const nextOperator = operatorFor(key)
  if (nextOperator) {
    if (state.operator === nextOperator) {
      const count = state.operatorCount * takeCount(state)
      clearPending(state)
      if (nextOperator === "change") {
        state.mode = "insert"
        state.oneShotNormal = false
      }
      return {
        consume: true,
        actions: [{ type: "operator-line", operator: nextOperator, count }],
      }
    }
    state.operator = nextOperator
    state.operatorCount = takeCount(state)
    return { consume: true, actions: [] }
  }

  if (state.operator) {
    if (key === "g") {
      state.prefix = "g"
      return { consume: true, actions: [] }
    }
    if (isMotionKey(key)) {
      const operator = state.operator
      const count = state.operatorCount * takeCount(state)
      clearPending(state)
      if (operator === "change") {
        state.mode = "insert"
        state.oneShotNormal = false
      }
      return {
        consume: true,
        actions: [{ type: "operator-motion", operator, key, count }],
      }
    }
    clearPending(state)
    return { consume: true, actions: [] }
  }

  if (isMotionKey(key)) {
    return {
      consume: true,
      actions: [{ type: "motion", key, count: takeCount(state) }],
    }
  }
  if (key === "g") {
    state.prefix = "g"
    return { consume: true, actions: [] }
  }
  if (key === "r") {
    state.prefix = "replace"
    return { consume: true, actions: [] }
  }
  if (isEnterKey(key)) {
    setMode(state, "insert")
    return { consume: true, actions: [{ type: "enter", key }] }
  }
  if (key === "v" || key === "V") {
    const oneShotNormal = state.oneShotNormal
    setMode(state, "visual")
    state.oneShotNormal = oneShotNormal
    state.lineVisual = key === "V"
    return {
      consume: true,
      actions: [{ type: "mode", mode: "visual", linewise: state.lineVisual }],
    }
  }
  if (key === "x" || key === "X") {
    return {
      consume: true,
      actions: [
        { type: "delete-char", backward: key === "X", count: takeCount(state) },
      ],
    }
  }
  if (key === "D" || key === "C") {
    const operator = key === "D" ? "delete" : "change"
    const count = takeCount(state)
    if (operator === "change") setMode(state, "insert")
    return {
      consume: true,
      actions: [{ type: "operator-motion", operator, key: "$", count }],
    }
  }
  if (key === "p" || key === "P") {
    return {
      consume: true,
      actions: [
        { type: "paste", before: key === "P", count: takeCount(state) },
      ],
    }
  }
  if (key === "J") {
    const count = takeCount(state)
    return {
      consume: true,
      actions: [{ type: "join-lines", count: count === 1 ? 1 : count - 1 }],
    }
  }
  const hostCommand = {
    "/": "session.timeline",
    "[": "session.half.page.up",
    "]": "session.half.page.down",
    "{": "session.message.previous",
    "}": "session.message.next",
  }[key]
  if (hostCommand) {
    clearPending(state)
    return {
      consume: true,
      actions: [{ type: "command", id: hostCommand }],
    }
  }
  if (key === "u") return { consume: true, actions: [{ type: "undo" }] }
  if (key === "ctrl+r") return { consume: true, actions: [{ type: "redo" }] }
  if (key === "return") return { consume: true, actions: [{ type: "submit" }] }
  if (key === ":") return { consume: true, actions: [{ type: "palette" }] }
  return { consume: true, actions: [] }
}

function transitionVisual(state: VimState, key: string): Transition {
  if (state.prefix === "g") {
    state.prefix = null
    const count = takeCount(state)
    if (key === "g")
      return { consume: true, actions: [{ type: "motion", key: "gg", count }] }
    clearPending(state)
    return { consume: true, actions: [] }
  }
  if (/^[1-9]$/.test(key) || (key === "0" && state.count > 0)) {
    state.count = state.count * 10 + Number(key)
    return { consume: true, actions: [] }
  }
  if (key === "escape" || key === "v" || key === "V") {
    const mode = state.oneShotNormal ? "insert" : "normal"
    setMode(state, mode)
    return { consume: true, actions: [{ type: "mode", mode }] }
  }
  const operator = operatorFor(key === "x" ? "d" : key)
  if (operator) {
    const linewise = state.lineVisual
    const mode =
      operator === "change" || state.oneShotNormal ? "insert" : "normal"
    setMode(state, mode)
    return {
      consume: true,
      actions: [{ type: "visual-operator", operator, linewise }],
    }
  }
  if (isMotionKey(key)) {
    return {
      consume: true,
      actions: [{ type: "motion", key, count: takeCount(state) }],
    }
  }
  if (key === "g") {
    state.prefix = "g"
    return { consume: true, actions: [] }
  }
  return { consume: true, actions: [] }
}
