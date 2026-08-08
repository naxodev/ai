import { expect } from "bun:test"
import { fileURLToPath } from "node:url"
import {
  beginInsertSession,
  createVimHistory,
  runActions,
  type Register,
  type VimEditor,
} from "../editor-actions.ts"
import {
  createVimState,
  hasPendingInput,
  transition,
  type VimMode,
} from "../engine.ts"

export type ParityCase = {
  name: string
  text: string
  cursor: number
  keys: string[]
  mode?: Extract<VimMode, "insert" | "normal">
  register?: { text: string; type: "characterwise" | "linewise" }
}

export type EditorSnapshot = {
  text: string
  cursor: number
  mode: VimMode
  register: { text: string; type: "characterwise" | "linewise" }
  pending: boolean
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function segments(text: string) {
  return [...segmenter.segment(text)]
}

function previousGrapheme(text: string, offset: number) {
  return (
    segments(text)
      .map((segment) => segment.index)
      .filter((index) => index < offset)
      .at(-1) ?? 0
  )
}

function nextGrapheme(text: string, offset: number) {
  const segment = segments(text).find((candidate) => candidate.index >= offset)
  return segment ? segment.index + segment.segment.length : text.length
}

function lineBounds(text: string, offset: number) {
  const start = offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1
  const newline = text.indexOf("\n", start)
  return { start, end: newline === -1 ? text.length : newline }
}

function characterKind(character: string) {
  if (/\s/u.test(character)) return "space"
  return /[\p{L}\p{N}_]/u.test(character) ? "word" : "punctuation"
}

function wordForward(text: string, offset: number) {
  const graphemes = segments(text)
  let index = graphemes.findIndex((segment) => segment.index >= offset)
  if (index < 0) return text.length
  const currentKind = characterKind(graphemes[index]?.segment ?? "")
  while (
    index < graphemes.length &&
    characterKind(graphemes[index]?.segment ?? "") === currentKind
  )
    index++
  while (
    index < graphemes.length &&
    characterKind(graphemes[index]?.segment ?? "") === "space"
  )
    index++
  return graphemes[index]?.index ?? text.length
}

function wordBackward(text: string, offset: number) {
  const graphemes = segments(text)
  let index = graphemes.findLastIndex((segment) => segment.index < offset)
  while (
    index >= 0 &&
    characterKind(graphemes[index]?.segment ?? "") === "space"
  )
    index--
  const kind = characterKind(graphemes[index]?.segment ?? "")
  while (
    index > 0 &&
    characterKind(graphemes[index - 1]?.segment ?? "") === kind
  )
    index--
  return graphemes[index]?.index ?? 0
}

class SemanticEditor implements VimEditor {
  selection: { start: number; end: number } | null = null
  private selectionAnchor: number | null = null
  private inclusiveSelection = false

  constructor(
    public plainText: string,
    public cursorOffset: number,
  ) {}

  get lineCount() {
    return this.plainText.split("\n").length
  }

  hasSelection() {
    return this.selection !== null
  }

  getSelection() {
    return this.selection
  }

  setSelection(start: number, end: number) {
    this.selectionAnchor = start
    this.inclusiveSelection = true
    this.selection = { start: Math.min(start, end), end: Math.max(start, end) }
  }

  setSelectionInclusive(start: number, end: number) {
    this.selectionAnchor = start
    this.inclusiveSelection = true
    this.selection = {
      start: Math.min(start, end),
      end: nextGrapheme(this.plainText, Math.max(start, end)),
    }
  }

  clearSelection() {
    const selected = this.selection !== null
    this.selection = null
    this.selectionAnchor = null
    this.inclusiveSelection = false
    return selected
  }

  private moveTo(target: number, select = false) {
    const origin = this.cursorOffset
    this.cursorOffset = Math.max(0, Math.min(target, this.plainText.length))
    if (select) {
      const anchor = this.selectionAnchor ?? origin
      this.selectionAnchor = anchor
      if (this.inclusiveSelection)
        this.selection = {
          start: Math.min(anchor, this.cursorOffset),
          end: nextGrapheme(
            this.plainText,
            Math.max(anchor, this.cursorOffset),
          ),
        }
      else
        this.selection = {
          start: Math.min(anchor, this.cursorOffset),
          end: Math.max(anchor, this.cursorOffset),
        }
    }
    return origin !== this.cursorOffset
  }

  moveCursorLeft(options?: { select?: boolean }) {
    const bounds = lineBounds(this.plainText, this.cursorOffset)
    return this.moveTo(
      Math.max(
        bounds.start,
        previousGrapheme(this.plainText, this.cursorOffset),
      ),
      options?.select,
    )
  }

  moveCursorRight(options?: { select?: boolean }) {
    const bounds = lineBounds(this.plainText, this.cursorOffset)
    const target = nextGrapheme(this.plainText, this.cursorOffset)
    return this.moveTo(Math.min(bounds.end, target), options?.select)
  }

  private moveVertical(delta: number, select = false) {
    const before = this.plainText.slice(0, this.cursorOffset).split("\n")
    const row = before.length - 1
    const displayWidth = (value: string) => {
      let width = 0
      for (const segment of segments(value))
        width +=
          segment.segment === "\t"
            ? 8 - (width % 8)
            : Bun.stringWidth(segment.segment)
      return width
    }
    const column = displayWidth(before.at(-1) ?? "")
    const lines = this.plainText.split("\n")
    const targetRow = Math.max(0, Math.min(row + delta, lines.length - 1))
    const lineStart = lines
      .slice(0, targetRow)
      .reduce((sum, line) => sum + line.length + 1, 0)
    const line = lines[targetRow] ?? ""
    let targetColumn = 0
    let width = 0
    for (const segment of segments(line)) {
      if (width > column) break
      targetColumn = segment.index
      width = displayWidth(
        line.slice(0, segment.index + segment.segment.length),
      )
    }
    const target = lineStart + targetColumn
    return this.moveTo(target, select)
  }

  moveCursorUp(options?: { select?: boolean }) {
    return this.moveVertical(-1, options?.select)
  }

  moveCursorDown(options?: { select?: boolean }) {
    return this.moveVertical(1, options?.select)
  }

  moveWordForward(options?: { select?: boolean }) {
    return this.moveTo(
      wordForward(this.plainText, this.cursorOffset),
      options?.select,
    )
  }

  moveWordBackward(options?: { select?: boolean }) {
    return this.moveTo(
      wordBackward(this.plainText, this.cursorOffset),
      options?.select,
    )
  }

  setText(text: string) {
    this.plainText = text
  }

  replaceText(text: string) {
    this.plainText = text
  }

  undo() {
    return false
  }

  redo() {
    return false
  }
}

function tokenToNvim(token: string) {
  const special: Record<string, string> = {
    escape: "<Esc>",
    "ctrl+[": "<C-[>",
    "ctrl+o": "<C-o>",
    "ctrl+r": "<C-r>",
    return: "<CR>",
    space: "<Space>",
    tab: "<Tab>",
  }
  return special[token] ?? token
}

function offsetToNvimCursor(text: string, offset: number) {
  const before = text.slice(0, offset)
  const lines = before.split("\n")
  const line = lines.at(-1) ?? ""
  return {
    row: lines.length,
    byteColumn: Buffer.byteLength(line, "utf8"),
  }
}

function insertOracleStart(text: string, offset: number) {
  const { start } = lineBounds(text, offset)
  if (offset === start)
    return { cursor: offsetToNvimCursor(text, offset), prefix: "i" }
  const cursor = previousGrapheme(text, offset)
  return { cursor: offsetToNvimCursor(text, cursor), prefix: "a" }
}

export function nvimByteCursorToOffset(
  text: string,
  row: number,
  byteColumn: number,
) {
  const lines = text.split("\n")
  const line = lines[row - 1] ?? ""
  let lineOffset = 0
  let bytes = 0
  for (const segment of segments(line)) {
    const nextBytes = bytes + Buffer.byteLength(segment.segment, "utf8")
    if (byteColumn < nextBytes) {
      lineOffset = segment.index
      break
    }
    bytes = nextBytes
    lineOffset = segment.index + segment.segment.length
  }
  const preceding = lines
    .slice(0, Math.max(0, row - 1))
    .reduce((sum, value) => sum + value.length + 1, 0)
  return preceding + lineOffset
}

export function runImplementation(testCase: ParityCase): EditorSnapshot {
  const mode = testCase.mode ?? "normal"
  const state = createVimState(mode)
  const editor = new SemanticEditor(testCase.text, testCase.cursor)
  const register: Register = {
    value: testCase.register?.text ?? "",
    linewise: testCase.register?.type === "linewise",
  }
  const history = createVimHistory(editor.plainText)
  if (mode === "insert") beginInsertSession(editor, history)
  for (const key of testCase.keys) {
    const result = transition(state, key)
    runActions(editor, result.actions, register, state, history, {
      dispatch() {},
      writeClipboard() {},
      transitionRuntime(mutation) {
        mutation(state)
      },
    })
    if (!result.consume) {
      const text = key === "space" ? " " : key === "tab" ? "\t" : key
      if ([...text].length === 1) {
        editor.replaceText(
          editor.plainText.slice(0, editor.cursorOffset) +
            text +
            editor.plainText.slice(editor.cursorOffset),
        )
        editor.cursorOffset += text.length
        history.currentText = editor.plainText
      }
    }
  }
  return {
    text: editor.plainText,
    cursor: editor.cursorOffset,
    mode: state.mode,
    register: {
      text: register.value,
      type: register.linewise ? "linewise" : "characterwise",
    },
    pending: hasPendingInput(state),
  }
}

export function runNeovim(cases: ParityCase[]): EditorSnapshot[] {
  const oracle = fileURLToPath(new URL("./nvim-oracle.lua", import.meta.url))
  const request = {
    cases: cases.map((testCase) => {
      const insert =
        testCase.mode === "insert"
          ? insertOracleStart(testCase.text, testCase.cursor)
          : undefined
      return {
        name: testCase.name,
        text: testCase.text,
        cursor:
          insert?.cursor ?? offsetToNvimCursor(testCase.text, testCase.cursor),
        mode: testCase.mode ?? "normal",
        keys: (insert?.prefix ?? "") + testCase.keys.map(tokenToNvim).join(""),
        register: testCase.register ?? { text: "", type: "characterwise" },
      }
    }),
  }
  const process = Bun.spawnSync(
    ["nvim", "--headless", "-u", "NONE", "-n", "-l", oracle],
    {
      stdin: Buffer.from(JSON.stringify(request)),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (process.exitCode !== 0)
    throw new Error(`Neovim oracle failed:\n${process.stderr.toString()}`)
  const marker = process.stdout
    .toString()
    .split("\n")
    .find((line) => line.startsWith("OPENCODE_VIM_ORACLE="))
  if (!marker) throw new Error(`Neovim oracle returned no result`)
  const raw = JSON.parse(marker.slice("OPENCODE_VIM_ORACLE=".length)) as Array<
    Omit<EditorSnapshot, "cursor"> & {
      cursor: { row: number; byteColumn: number }
    }
  >
  return raw.map((result) => ({
    ...result,
    cursor: nvimByteCursorToOffset(
      result.text,
      result.cursor.row,
      result.cursor.byteColumn,
    ),
  }))
}

export function expectParity(cases: ParityCase[]) {
  const oracle = runNeovim(cases)
  for (const [index, testCase] of cases.entries())
    expect(runImplementation(testCase), testCase.name).toEqual(oracle[index]!)
}
