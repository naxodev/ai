import type {
  EnterKey,
  MotionKey,
  Operator,
  VimAction,
  VimState,
} from "./engine.ts"

export type Register = { value: string; linewise: boolean }
type Snapshot = { text: string; cursor: number }
export type VimHistory = {
  undo: Snapshot[]
  redo: Snapshot[]
  currentText: string
}

export function createVimHistory(text = ""): VimHistory {
  return { undo: [], redo: [], currentText: text }
}

export function syncVimHistory(history: VimHistory, text: string) {
  if (history.currentText === text) return
  history.undo.length = 0
  history.redo.length = 0
  history.currentText = text
}

export interface VimEditor {
  plainText: string
  cursorOffset: number
  lineCount: number
  hasSelection(): boolean
  getSelection(): { start: number; end: number } | null
  setSelection(start: number, end: number): void
  setSelectionInclusive(start: number, end: number): void
  clearSelection(): boolean
  moveCursorLeft(options?: { select?: boolean }): boolean
  moveCursorRight(options?: { select?: boolean }): boolean
  moveCursorUp(options?: { select?: boolean }): boolean
  moveCursorDown(options?: { select?: boolean }): boolean
  moveWordForward(options?: { select?: boolean }): boolean
  moveWordBackward(options?: { select?: boolean }): boolean
  setText(text: string): void
  replaceText(text: string): void
  undo(): boolean
  redo(): boolean
}

export type ActionEffects = {
  dispatch(id: string): void
  writeClipboard(text: string): void
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function graphemeSegments(text: string) {
  return [...graphemes.segment(text)]
}

function advanceGraphemes(
  text: string,
  offset: number,
  count: number,
  limit = text.length,
) {
  let end = offset
  for (const segment of graphemeSegments(text)) {
    if (segment.index < offset) continue
    if (count-- <= 0) break
    end = Math.min(limit, segment.index + segment.segment.length)
    if (end >= limit) break
  }
  return end
}

function retreatGraphemes(
  text: string,
  offset: number,
  count: number,
  limit = 0,
) {
  const starts = graphemeSegments(text)
    .map((segment) => segment.index)
    .filter((index) => index < offset && index >= limit)
  return starts[Math.max(0, starts.length - count)] ?? limit
}

function lastGraphemeStart(text: string) {
  return graphemeSegments(text).at(-1)?.index ?? 0
}

export function lineBounds(text: string, rawOffset: number) {
  const offset = Math.max(0, Math.min(rawOffset, text.length))
  const start = offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1
  const newline = text.indexOf("\n", start)
  return { start, end: newline === -1 ? text.length : newline }
}

export function lineRange(text: string, offset: number, count: number) {
  const { start } = lineBounds(text, offset)
  let end = start
  for (let index = 0; index < Math.max(1, count); index++) {
    const newline = text.indexOf("\n", end)
    end = newline === -1 ? text.length : newline + 1
  }
  return { start, end }
}

function rowStart(text: string, row: number) {
  let offset = 0
  for (let index = 0; index < row; index++) {
    const newline = text.indexOf("\n", offset)
    if (newline === -1) return text.length
    offset = newline + 1
  }
  return offset
}

function rowAt(text: string, offset: number) {
  let row = 0
  for (let index = 0; index < Math.min(offset, text.length); index++) {
    if (text[index] === "\n") row++
  }
  return row
}

function firstNonblank(text: string, start: number) {
  const bounds = lineBounds(text, start)
  return (
    bounds.start +
    (text.slice(bounds.start, bounds.end).match(/^[ \t]*/)?.[0].length ?? 0)
  )
}

function cursorAtColumn(text: string, start: number, column: number) {
  const { end } = lineBounds(text, start)
  if (start === end) return start
  const desired = Math.min(start + column, end)
  let target = start
  for (const segment of graphemeSegments(text.slice(start, end))) {
    const offset = start + segment.index
    if (offset > desired) break
    target = offset
  }
  return Math.min(target, retreatGraphemes(text, end, 1, start))
}

function replaceRange(
  editor: VimEditor,
  start: number,
  end: number,
  replacement: string,
  cursor: number,
) {
  const next =
    editor.plainText.slice(0, start) + replacement + editor.plainText.slice(end)
  editor.replaceText(next)
  editor.cursorOffset = Math.max(0, Math.min(cursor, next.length))
}

function endOfWord(text: string, offset: number, count: number) {
  let position = offset
  const kind = (character: string) => {
    if (/\s/.test(character)) return "space"
    return /\w/.test(character) ? "word" : "punctuation"
  }
  for (let step = 0; step < count; step++) {
    if (position < text.length - 1 && kind(text[position] ?? "") !== "space")
      position++
    while (position < text.length && kind(text[position] ?? "") === "space")
      position++
    const current = kind(text[position] ?? "")
    while (
      position < text.length - 1 &&
      kind(text[position + 1] ?? "") === current
    )
      position++
  }
  return Math.max(0, Math.min(position, Math.max(0, text.length - 1)))
}

function destinationRow(editor: VimEditor, key: MotionKey, count: number) {
  const current = rowAt(editor.plainText, editor.cursorOffset)
  if (key === "j") return Math.min(current + count, editor.lineCount - 1)
  if (key === "k") return Math.max(0, current - count)
  if (key === "gg")
    return Math.min(Math.max(0, count - 1), editor.lineCount - 1)
  if (key === "G")
    return count > 1
      ? Math.min(count - 1, editor.lineCount - 1)
      : editor.lineCount - 1
  return current
}

function move(
  editor: VimEditor,
  key: MotionKey,
  count: number,
  select: boolean,
) {
  const selectionStart = editor.cursorOffset
  for (let index = 0; index < count; index++) {
    if (key === "h") editor.moveCursorLeft({ select })
    if (key === "j") editor.moveCursorDown({ select })
    if (key === "k") editor.moveCursorUp({ select })
    if (key === "l") editor.moveCursorRight({ select })
    if (key === "w") editor.moveWordForward({ select })
    if (key === "b") editor.moveWordBackward({ select })
  }
  if (key === "0" || key === "^") {
    const bounds = lineBounds(editor.plainText, editor.cursorOffset)
    const target =
      key === "^" ? firstNonblank(editor.plainText, bounds.start) : bounds.start
    if (select) editor.setSelectionInclusive(selectionStart, target)
    editor.cursorOffset = target
  }
  if (key === "$") {
    const row = Math.min(
      rowAt(editor.plainText, editor.cursorOffset) + count - 1,
      editor.lineCount - 1,
    )
    const bounds = lineBounds(editor.plainText, rowStart(editor.plainText, row))
    const target = Math.max(bounds.start, bounds.end - 1)
    if (select) editor.setSelectionInclusive(selectionStart, target)
    editor.cursorOffset = target
  }
  if (key === "G" || key === "gg") {
    const target = firstNonblank(
      editor.plainText,
      rowStart(editor.plainText, destinationRow(editor, key, count)),
    )
    if (select) editor.setSelectionInclusive(selectionStart, target)
    editor.cursorOffset = target
  }
  if (key === "e") {
    const target = endOfWord(editor.plainText, editor.cursorOffset, count)
    if (select) editor.setSelectionInclusive(selectionStart, target)
    editor.cursorOffset = target
  }
}

function linewiseMotionRange(editor: VimEditor, key: MotionKey, count: number) {
  const currentRow = rowAt(editor.plainText, editor.cursorOffset)
  const targetRow = destinationRow(editor, key, count)
  const firstRow = Math.min(currentRow, targetRow)
  const lastRow = Math.max(currentRow, targetRow)
  return lineRange(
    editor.plainText,
    rowStart(editor.plainText, firstRow),
    lastRow - firstRow + 1,
  )
}

function linewiseValue(text: string) {
  return text.endsWith("\n") ? text.slice(0, -1) : text
}

function applyLineRange(
  editor: VimEditor,
  operator: Operator,
  range: { start: number; end: number },
  setRegister: (text: string, linewise?: boolean) => void,
  writeClipboard: (text: string) => void,
  yankCursor = firstNonblank(editor.plainText, range.start),
) {
  const selected = editor.plainText.slice(range.start, range.end)
  const value = linewiseValue(selected)
  setRegister(value, true)
  if (operator === "yank") {
    writeClipboard(`${value}\n`)
    editor.cursorOffset = yankCursor
    return
  }
  if (operator === "change") {
    const end = selected.endsWith("\n") ? range.end - 1 : range.end
    replaceRange(editor, range.start, end, "", range.start)
    return
  }
  let start = range.start
  if (
    range.end === editor.plainText.length &&
    start > 0 &&
    !selected.endsWith("\n")
  )
    start--
  replaceRange(editor, start, range.end, "", start)
  editor.cursorOffset = firstNonblank(editor.plainText, editor.cursorOffset)
}

function applyOperatorMotion(
  editor: VimEditor,
  operator: Operator,
  key: MotionKey,
  count: number,
  setRegister: (text: string, linewise?: boolean) => void,
  writeClipboard: (text: string) => void,
) {
  if (key === "j" || key === "k" || key === "G" || key === "gg") {
    const currentStart = lineBounds(editor.plainText, editor.cursorOffset).start
    const column = editor.cursorOffset - currentStart
    const range = linewiseMotionRange(editor, key, count)
    applyLineRange(
      editor,
      operator,
      range,
      setRegister,
      writeClipboard,
      cursorAtColumn(editor.plainText, range.start, column),
    )
    return
  }
  const original = editor.cursorOffset
  editor.clearSelection()
  move(editor, key, count, true)
  const selection = editor.getSelection()
  if (!selection) return
  const selected = editor.plainText.slice(selection.start, selection.end)
  if (selected) setRegister(selected)
  editor.clearSelection()
  if (operator === "yank") {
    if (selected) writeClipboard(selected)
    editor.cursorOffset = original
  } else
    replaceRange(editor, selection.start, selection.end, "", selection.start)
}

function pasteLinewise(
  editor: VimEditor,
  register: Register,
  before: boolean,
  count: number,
) {
  const oldText = editor.plainText
  const bounds = lineBounds(oldText, editor.cursorOffset)
  const lines = Array.from({ length: count }, () => register.value).join("\n")
  let insertion: number
  let text: string
  let firstInserted: number
  if (before) {
    insertion = bounds.start
    text = `${lines}\n`
    firstInserted = insertion
  } else if (bounds.end < oldText.length) {
    insertion = bounds.end + 1
    text = `${lines}\n`
    firstInserted = insertion
  } else {
    insertion = oldText.length
    const prefix = oldText.length === 0 ? "" : "\n"
    text = `${prefix}${lines}`
    firstInserted = insertion + prefix.length
  }
  replaceRange(editor, insertion, insertion, text, firstInserted)
  editor.cursorOffset = firstNonblank(editor.plainText, firstInserted)
}

function enter(editor: VimEditor, key: EnterKey) {
  if (key === "a") editor.moveCursorRight()
  if (key === "A")
    editor.cursorOffset = lineBounds(editor.plainText, editor.cursorOffset).end
  if (key === "I")
    editor.cursorOffset = firstNonblank(editor.plainText, editor.cursorOffset)
  if (key === "o") {
    const end = lineBounds(editor.plainText, editor.cursorOffset).end
    replaceRange(editor, end, end, "\n", end + 1)
  }
  if (key === "O") {
    const start = lineBounds(editor.plainText, editor.cursorOffset).start
    replaceRange(editor, start, start, "\n", start)
  }
}

export function runActions(
  editor: VimEditor,
  actions: VimAction[],
  register: Register,
  runtime: VimState,
  history: VimHistory,
  effects: ActionEffects,
) {
  const before = { text: editor.plainText, cursor: editor.cursorOffset }
  let historyAction = false
  const setRegister = (text: string, linewise = false) => {
    register.value = linewise ? linewiseValue(text) : text
    register.linewise = linewise
  }
  for (const action of actions) {
    if (action.type === "motion") {
      move(editor, action.key, action.count, editor.hasSelection())
      if (runtime.mode === "visual" && runtime.lineVisual) {
        const selection = editor.getSelection()
        if (selection) {
          const start = lineBounds(editor.plainText, selection.start).start
          const end = lineRange(
            editor.plainText,
            Math.max(start, selection.end - 1),
            1,
          ).end
          editor.setSelection(start, end)
        }
      }
    }
    if (action.type === "operator-motion")
      applyOperatorMotion(
        editor,
        action.operator,
        action.key,
        action.count,
        setRegister,
        effects.writeClipboard,
      )
    if (action.type === "operator-line")
      applyLineRange(
        editor,
        action.operator,
        lineRange(editor.plainText, editor.cursorOffset, action.count),
        setRegister,
        effects.writeClipboard,
        editor.cursorOffset,
      )
    if (action.type === "delete-char") {
      const bounds = lineBounds(editor.plainText, editor.cursorOffset)
      const start = action.backward
        ? retreatGraphemes(
            editor.plainText,
            editor.cursorOffset,
            action.count,
            bounds.start,
          )
        : editor.cursorOffset
      const end = action.backward
        ? editor.cursorOffset
        : advanceGraphemes(
            editor.plainText,
            editor.cursorOffset,
            action.count,
            bounds.end,
          )
      const deleted = editor.plainText.slice(start, end)
      if (deleted) {
        setRegister(deleted)
        replaceRange(editor, start, end, "", start)
      }
    }
    if (
      action.type === "paste" &&
      (register.value !== "" || register.linewise)
    ) {
      if (register.linewise)
        pasteLinewise(editor, register, action.before, action.count)
      else {
        const insertion = action.before
          ? editor.cursorOffset
          : advanceGraphemes(
              editor.plainText,
              editor.cursorOffset,
              1,
              lineBounds(editor.plainText, editor.cursorOffset).end,
            )
        const text = register.value.repeat(action.count)
        replaceRange(
          editor,
          insertion,
          insertion,
          text,
          insertion + lastGraphemeStart(text),
        )
      }
    }
    if (action.type === "replace") {
      const bounds = lineBounds(editor.plainText, editor.cursorOffset)
      const end = advanceGraphemes(
        editor.plainText,
        editor.cursorOffset,
        action.count,
        bounds.end,
      )
      const count = graphemeSegments(
        editor.plainText.slice(editor.cursorOffset, end),
      ).length
      if (count > 0) {
        const replacement = action.text.repeat(count)
        replaceRange(
          editor,
          editor.cursorOffset,
          end,
          replacement,
          editor.cursorOffset + lastGraphemeStart(replacement),
        )
      }
    }
    if (action.type === "command") effects.dispatch(action.id)
    if (action.type === "join-lines") {
      let text = editor.plainText
      let cursor = editor.cursorOffset
      for (let index = 0; index < action.count; index++) {
        const bounds = lineBounds(text, cursor)
        if (bounds.end >= text.length) break
        let nextText = bounds.end + 1
        while (text[nextText] === " " || text[nextText] === "\t") nextText++
        const space =
          bounds.end > bounds.start &&
          nextText < text.length &&
          text[nextText] !== "\n" &&
          !/\s/.test(text[bounds.end - 1] ?? "")
            ? " "
            : ""
        text = text.slice(0, bounds.end) + space + text.slice(nextText)
        cursor = bounds.end
      }
      if (text !== editor.plainText) {
        editor.replaceText(text)
        editor.cursorOffset = cursor
      }
    }
    if (action.type === "undo") {
      historyAction = true
      const snapshot = history.undo.pop()
      if (snapshot) {
        history.redo.push({
          text: editor.plainText,
          cursor: editor.cursorOffset,
        })
        editor.setText(snapshot.text)
        editor.cursorOffset = snapshot.cursor
      } else editor.undo()
    }
    if (action.type === "redo") {
      historyAction = true
      const snapshot = history.redo.pop()
      if (snapshot) {
        history.undo.push({
          text: editor.plainText,
          cursor: editor.cursorOffset,
        })
        editor.setText(snapshot.text)
        editor.cursorOffset = snapshot.cursor
      } else editor.redo()
    }
    if (action.type === "submit") effects.dispatch("input.submit")
    if (action.type === "palette") effects.dispatch("command.palette.show")
    if (action.type === "enter") enter(editor, action.key)
    if (action.type === "visual-operator") {
      const selection = editor.getSelection()
      if (selection) {
        if (action.linewise) {
          editor.clearSelection()
          applyLineRange(
            editor,
            action.operator,
            selection,
            setRegister,
            effects.writeClipboard,
          )
          if (action.operator === "yank") editor.cursorOffset = selection.start
          continue
        }
        setRegister(
          editor.plainText.slice(selection.start, selection.end),
          false,
        )
        editor.clearSelection()
        if (action.operator === "yank") {
          effects.writeClipboard(register.value)
          editor.cursorOffset = selection.start
        } else
          replaceRange(
            editor,
            selection.start,
            selection.end,
            "",
            selection.start,
          )
      }
    }
    if (action.type === "mode") {
      if (action.mode === "visual") {
        if (action.linewise) {
          const range = lineRange(editor.plainText, editor.cursorOffset, 1)
          editor.setSelection(range.start, range.end)
        } else
          editor.setSelectionInclusive(editor.cursorOffset, editor.cursorOffset)
      } else if (editor.hasSelection()) editor.clearSelection()
      else if (action.mode === "normal" && !action.oneShot)
        editor.moveCursorLeft()
    }
  }
  if (!historyAction && editor.plainText !== before.text) {
    history.undo.push(before)
    history.redo.length = 0
  }
  history.currentText = editor.plainText
}
