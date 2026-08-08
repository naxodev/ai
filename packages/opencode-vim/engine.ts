export type VimMode = "insert" | "normal" | "visual"
export type Operator = "delete" | "change" | "yank"
export type MotionKey =
  | "h"
  | "j"
  | "k"
  | "l"
  | "w"
  | "b"
  | "e"
  | "W"
  | "B"
  | "E"
  | "0"
  | "^"
  | "$"
  | "%"
  | "G"
  | "gg"
export type EnterKey = "i" | "a" | "A" | "I" | "o" | "O"
export type FindDirection = "forward" | "backward"
export type CharacterFind = {
  direction: FindDirection
  till: boolean
  target: string
}
export type TextObject =
  "word" | "paren" | "brace" | "bracket" | "double-quote" | "single-quote"

const enterKeys = new Set<EnterKey>(["i", "a", "A", "I", "o", "O"])
const MAX_COUNT = 999

function isEnterKey(key: string): key is EnterKey {
  return enterKeys.has(key as EnterKey)
}

export type PendingCommand =
  | { type: "none"; count: number }
  | { type: "prefix"; prefix: "g" | "replace"; count: number }
  | {
      type: "find"
      find: Omit<CharacterFind, "target">
      count: number
      operator: Operator | null
    }
  | {
      type: "operator"
      operator: Operator
      count: number
      motionCount: number
      prefix: "g" | "inner" | "around" | null
    }

export type VisualState = {
  kind: "character" | "line"
  anchor: number | null
  active: number | null
}
export type VisualShape = {
  graphemes: number
  lines: number
  endColumn: number
  linewise: boolean
}

export type VimState = {
  mode: VimMode
  oneShotNormal: boolean
  pending: PendingCommand
  visual: VisualState | null
  lastFind: CharacterFind | null
}

export type VimAction =
  | { type: "motion"; key: MotionKey; count: number; percentage?: boolean }
  | {
      type: "find"
      find: CharacterFind
      count: number
      operator?: Operator
      repeat?: boolean
    }
  | {
      type: "text-object"
      object: TextObject
      around: boolean
      count: number
      operator?: Operator
    }
  | {
      type: "operator-motion"
      operator: Operator
      key: MotionKey
      count: number
      percentage?: boolean
    }
  | { type: "operator-line"; operator: Operator; count: number }
  | { type: "enter"; key: EnterKey; count: number }
  | { type: "mode"; mode: VimMode; linewise?: boolean; oneShot?: boolean }
  | { type: "delete-char"; backward: boolean; count: number }
  | { type: "paste"; before: boolean; count: number }
  | { type: "replace"; text: string; count: number }
  | {
      type: "visual-operator"
      operator: Operator
      linewise: boolean
      shape?: VisualShape
      preserveRegister?: boolean
    }
  | { type: "visual-swap" }
  | {
      type: "visual-paste"
      preserveRegister: boolean
      count: number
      shape?: VisualShape
    }
  | { type: "visual-replace"; text: string; shape?: VisualShape }
  | { type: "visual-join"; shape?: VisualShape }
  | { type: "visual-case"; shape?: VisualShape }
  | {
      type: "visual-indent"
      direction: "left" | "right"
      count: number
      shape?: VisualShape
    }
  | { type: "command"; id: string }
  | { type: "join-lines"; count: number }
  | { type: "repeat"; count?: number }
  | { type: "undo" | "redo" | "ex" }

export type Transition = { consume: boolean; actions: VimAction[] }

const motions = new Set<MotionKey>([
  "h",
  "j",
  "k",
  "l",
  "w",
  "b",
  "e",
  "W",
  "B",
  "E",
  "0",
  "^",
  "$",
  "%",
  "G",
])

function isMotionKey(key: string): key is MotionKey {
  return motions.has(key as MotionKey)
}

export function createVimState(startMode: VimMode = "insert"): VimState {
  return {
    mode: startMode,
    oneShotNormal: false,
    pending: { type: "none", count: 0 },
    visual: null,
    lastFind: null,
  }
}

export function hasPendingInput(state: VimState) {
  return state.pending.type !== "none" || state.pending.count > 0
}

function takeCount(state: VimState): number {
  const count =
    state.pending.type === "operator"
      ? state.pending.motionCount || 1
      : state.pending.count || 1
  if (state.pending.type === "operator") state.pending.motionCount = 0
  else state.pending.count = 0
  return count
}

function clearPending(state: VimState) {
  state.pending = { type: "none", count: 0 }
}

function appendCount(state: VimState, digit: number) {
  if (state.pending.type === "operator") {
    state.pending.motionCount = Math.min(
      MAX_COUNT,
      state.pending.motionCount * 10 + digit,
    )
    return
  }
  state.pending.count = Math.min(MAX_COUNT, state.pending.count * 10 + digit)
}

function multiplyCounts(left: number, right: number) {
  return Math.min(MAX_COUNT, left * right)
}

function hasCount(state: VimState) {
  return state.pending.type === "operator"
    ? state.pending.motionCount > 0
    : state.pending.count > 0
}

function findForKey(key: string): Omit<CharacterFind, "target"> | null {
  if (key === "f") return { direction: "forward", till: false }
  if (key === "F") return { direction: "backward", till: false }
  if (key === "t") return { direction: "forward", till: true }
  if (key === "T") return { direction: "backward", till: true }
  return null
}

function textObjectForKey(key: string): TextObject | null {
  if (key === "w") return "word"
  if (key === "(") return "paren"
  if (key === "{") return "brace"
  if (key === "[") return "bracket"
  if (key === '"') return "double-quote"
  if (key === "'") return "single-quote"
  return null
}

function printableTarget(key: string) {
  if (key === "space") return " "
  if (key === "tab") return "\t"
  return [...key].length === 1 && !/^\p{Cc}$/u.test(key) ? key : null
}

function commandComplete(state: VimState) {
  return state.pending.type === "none" && state.pending.count === 0
}

function setMode(state: VimState, mode: VimMode) {
  clearPending(state)
  state.mode = mode
  state.oneShotNormal = false
  state.visual = null
}

function operatorFor(key: string): Operator | null {
  if (key === "d") return "delete"
  if (key === "c") return "change"
  if (key === "y") return "yank"
  return null
}

export function transition(state: VimState, key: string): Transition {
  if (key === "ctrl+[") key = "escape"
  if (state.mode === "insert") {
    if (key === "return") {
      return {
        consume: true,
        actions: [{ type: "command", id: "input.newline" }],
      }
    }
    if (key === "ctrl+return") {
      return { consume: false, actions: [] }
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
    if (key !== "escape") return { consume: false, actions: [] }
    setMode(state, "normal")
    return { consume: true, actions: [{ type: "mode", mode: "normal" }] }
  }

  if (state.mode === "visual") return transitionVisual(state, key)
  const result = transitionNormal(state, key)
  if (
    state.oneShotNormal &&
    result.consume &&
    state.mode === "normal" &&
    commandComplete(state)
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

  if (state.pending.type === "prefix" && state.pending.prefix === "replace") {
    const count = takeCount(state)
    clearPending(state)
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

  if (state.pending.type === "find") {
    const pending = state.pending
    clearPending(state)
    const target = printableTarget(key)
    if (target === null) return { consume: true, actions: [] }
    const find = { ...pending.find, target }
    state.lastFind = find
    return {
      consume: true,
      actions: [
        {
          type: "find",
          find,
          count: pending.count,
          ...(pending.operator ? { operator: pending.operator } : {}),
        },
      ],
    }
  }

  if (state.pending.type === "prefix" && state.pending.prefix === "g") {
    const count = takeCount(state)
    clearPending(state)
    if (key === "g") {
      return { consume: true, actions: [{ type: "motion", key: "gg", count }] }
    }
    return { consume: true, actions: [] }
  }

  if (state.pending.type === "operator" && state.pending.prefix === "g") {
    const { operator, count: operatorCount } = state.pending
    const count = takeCount(state)
    clearPending(state)
    if (key !== "g") return { consume: true, actions: [] }
    if (operator === "change") setMode(state, "insert")
    return {
      consume: true,
      actions: [
        {
          type: "operator-motion",
          operator,
          key: "gg",
          count: multiplyCounts(operatorCount, count),
        },
      ],
    }
  }

  if (/^[1-9]$/.test(key) || (key === "0" && hasCount(state))) {
    appendCount(state, Number(key))
    return { consume: true, actions: [] }
  }

  const nextOperator = operatorFor(key)
  if (nextOperator) {
    if (
      state.pending.type === "operator" &&
      state.pending.operator === nextOperator
    ) {
      const count = multiplyCounts(state.pending.count, takeCount(state))
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
    const count = takeCount(state)
    state.pending = {
      type: "operator",
      operator: nextOperator,
      count,
      motionCount: 0,
      prefix: null,
    }
    return { consume: true, actions: [] }
  }

  if (state.pending.type === "operator") {
    if (key === "g") {
      state.pending.prefix = "g"
      return { consume: true, actions: [] }
    }
    if (key === "i" || key === "a") {
      if (
        state.pending.prefix === "inner" ||
        state.pending.prefix === "around"
      ) {
        clearPending(state)
        return { consume: true, actions: [] }
      }
      state.pending.prefix = key === "i" ? "inner" : "around"
      return { consume: true, actions: [] }
    }
    if (state.pending.prefix === "inner" || state.pending.prefix === "around") {
      const object = textObjectForKey(key)
      const operator = state.pending.operator
      const count = multiplyCounts(state.pending.count, takeCount(state))
      const around = state.pending.prefix === "around"
      clearPending(state)
      return object
        ? {
            consume: true,
            actions: [{ type: "text-object", object, around, count, operator }],
          }
        : { consume: true, actions: [] }
    }
    const find = findForKey(key)
    if (find) {
      const operator = state.pending.operator
      const count = multiplyCounts(state.pending.count, takeCount(state))
      state.pending = { type: "find", find, count, operator }
      return { consume: true, actions: [] }
    }
    if ((key === ";" || key === ",") && state.lastFind) {
      const operator = state.pending.operator
      const count = multiplyCounts(state.pending.count, takeCount(state))
      const find: CharacterFind =
        key === ";"
          ? state.lastFind
          : {
              ...state.lastFind,
              direction:
                state.lastFind.direction === "forward" ? "backward" : "forward",
            }
      clearPending(state)
      return {
        consume: true,
        actions: [{ type: "find", find, count, operator, repeat: true }],
      }
    }
    if (isMotionKey(key)) {
      const operator = state.pending.operator
      const percentage = key === "%" && hasCount(state)
      const count = multiplyCounts(state.pending.count, takeCount(state))
      clearPending(state)
      return {
        consume: true,
        actions: [
          {
            type: "operator-motion",
            operator,
            key,
            count,
            ...(percentage ? { percentage: true } : {}),
          },
        ],
      }
    }
    clearPending(state)
    return { consume: true, actions: [] }
  }

  const find = findForKey(key)
  if (find) {
    state.pending = {
      type: "find",
      find,
      count: takeCount(state),
      operator: null,
    }
    return { consume: true, actions: [] }
  }
  if ((key === ";" || key === ",") && state.lastFind) {
    const find: CharacterFind =
      key === ";"
        ? state.lastFind
        : {
            ...state.lastFind,
            direction:
              state.lastFind.direction === "forward" ? "backward" : "forward",
          }
    return {
      consume: true,
      actions: [{ type: "find", find, count: takeCount(state), repeat: true }],
    }
  }

  if (isMotionKey(key)) {
    const percentage = key === "%" && hasCount(state)
    return {
      consume: true,
      actions: [
        {
          type: "motion",
          key,
          count: takeCount(state),
          ...(percentage ? { percentage: true } : {}),
        },
      ],
    }
  }
  if (key === "g") {
    const count = takeCount(state)
    state.pending = { type: "prefix", prefix: "g", count }
    return { consume: true, actions: [] }
  }
  if (key === "r") {
    const count = takeCount(state)
    state.pending = { type: "prefix", prefix: "replace", count }
    return { consume: true, actions: [] }
  }
  if (isEnterKey(key)) {
    const count = takeCount(state)
    setMode(state, "insert")
    return { consume: true, actions: [{ type: "enter", key, count }] }
  }
  if (key === "v" || key === "V") {
    const oneShotNormal = state.oneShotNormal
    setMode(state, "visual")
    state.oneShotNormal = oneShotNormal
    state.visual = {
      kind: key === "V" ? "line" : "character",
      anchor: null,
      active: null,
    }
    return {
      consume: true,
      actions: [
        {
          type: "mode",
          mode: "visual",
          linewise: state.visual.kind === "line",
        },
      ],
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
      actions: [{ type: "join-lines", count }],
    }
  }
  if (key === ".") {
    const count = state.pending.count || undefined
    clearPending(state)
    return {
      consume: true,
      actions: [{ type: "repeat", ...(count ? { count } : {}) }],
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
  if (key === "return") return { consume: false, actions: [] }
  if (key === ":") return { consume: true, actions: [{ type: "ex" }] }
  return { consume: true, actions: [] }
}

function transitionVisual(state: VimState, key: string): Transition {
  if (key === "escape") {
    const mode = state.oneShotNormal ? "insert" : "normal"
    setMode(state, mode)
    return { consume: true, actions: [{ type: "mode", mode }] }
  }
  if (state.pending.type === "find") {
    const pending = state.pending
    clearPending(state)
    const target = printableTarget(key)
    if (target === null) return { consume: true, actions: [] }
    const find = { ...pending.find, target }
    state.lastFind = find
    return {
      consume: true,
      actions: [{ type: "find", find, count: pending.count }],
    }
  }
  if (state.pending.type === "prefix" && state.pending.prefix === "replace") {
    clearPending(state)
    if (key === "escape") return { consume: true, actions: [] }
    const replacement =
      key === "space"
        ? " "
        : key === "tab"
          ? "\t"
          : key === "return"
            ? null
            : printableTarget(key)
    return replacement === null
      ? { consume: true, actions: [] }
      : {
          consume: true,
          actions: [{ type: "visual-replace", text: replacement }],
        }
  }
  if (state.pending.type === "prefix" && state.pending.prefix === "g") {
    const count = takeCount(state)
    clearPending(state)
    if (key === "g")
      return { consume: true, actions: [{ type: "motion", key: "gg", count }] }
    return { consume: true, actions: [] }
  }
  if (/^[1-9]$/.test(key) || (key === "0" && hasCount(state))) {
    appendCount(state, Number(key))
    return { consume: true, actions: [] }
  }
  if (
    state.pending.type === "operator" &&
    (state.pending.prefix === "inner" || state.pending.prefix === "around")
  ) {
    const object = textObjectForKey(key)
    const count = multiplyCounts(state.pending.count, takeCount(state))
    const around = state.pending.prefix === "around"
    clearPending(state)
    return object
      ? {
          consume: true,
          actions: [{ type: "text-object", object, around, count }],
        }
      : { consume: true, actions: [] }
  }
  if (key === "v" || key === "V") {
    const mode = state.oneShotNormal ? "insert" : "normal"
    setMode(state, mode)
    return { consume: true, actions: [{ type: "mode", mode }] }
  }
  const visualLineChange = key === "C" || key === "S"
  const operator = operatorFor(key === "x" ? "d" : visualLineChange ? "c" : key)
  if (operator) {
    const linewise = visualLineChange || state.visual?.kind === "line"
    return {
      consume: true,
      actions: [{ type: "visual-operator", operator, linewise }],
    }
  }
  if (isMotionKey(key)) {
    const percentage = key === "%" && hasCount(state)
    return {
      consume: true,
      actions: [
        {
          type: "motion",
          key,
          count: takeCount(state),
          ...(percentage ? { percentage: true } : {}),
        },
      ],
    }
  }
  const find = findForKey(key)
  if (find) {
    state.pending = {
      type: "find",
      find,
      count: takeCount(state),
      operator: null,
    }
    return { consume: true, actions: [] }
  }
  if ((key === ";" || key === ",") && state.lastFind) {
    const find: CharacterFind =
      key === ";"
        ? state.lastFind
        : {
            ...state.lastFind,
            direction:
              state.lastFind.direction === "forward" ? "backward" : "forward",
          }
    return {
      consume: true,
      actions: [{ type: "find", find, count: takeCount(state), repeat: true }],
    }
  }
  if (key === "i" || key === "a") {
    if (
      state.pending.type === "operator" &&
      (state.pending.prefix === "inner" || state.pending.prefix === "around")
    ) {
      clearPending(state)
      return { consume: true, actions: [] }
    }
    const count = takeCount(state)
    state.pending = {
      type: "operator",
      operator: "yank",
      count,
      motionCount: 0,
      prefix: key === "i" ? "inner" : "around",
    }
    return { consume: true, actions: [] }
  }
  if (key === "g") {
    const count = takeCount(state)
    state.pending = { type: "prefix", prefix: "g", count }
    return { consume: true, actions: [] }
  }
  if (key === "r") {
    const count = takeCount(state)
    state.pending = { type: "prefix", prefix: "replace", count }
    return { consume: true, actions: [] }
  }
  if (key === "o") return { consume: true, actions: [{ type: "visual-swap" }] }
  if (key === "p" || key === "P")
    return {
      consume: true,
      actions: [
        {
          type: "visual-paste",
          preserveRegister: key === "P",
          count: takeCount(state),
        },
      ],
    }
  if (key === "J") return { consume: true, actions: [{ type: "visual-join" }] }
  if (key === "~") return { consume: true, actions: [{ type: "visual-case" }] }
  if (key === ">" || key === "<")
    return {
      consume: true,
      actions: [
        {
          type: "visual-indent",
          direction: key === ">" ? "right" : "left",
          count: takeCount(state),
        },
      ],
    }
  return { consume: true, actions: [] }
}
