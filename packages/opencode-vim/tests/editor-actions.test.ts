import { describe, expect, test } from "bun:test"
import {
  createVimHistory,
  lineBounds,
  lineRange,
  type Register,
  runActions,
  type VimEditor,
} from "../editor-actions.ts"
import { createVimState } from "../engine.ts"

class FakeEditor implements VimEditor {
  cursorOffset = 0
  selection: { start: number; end: number } | null = null
  replacements = 0

  constructor(public plainText: string) {}

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
    this.selection = { start: Math.min(start, end), end: Math.max(start, end) }
  }

  setSelectionInclusive(start: number, end: number) {
    this.selection = {
      start: Math.min(start, end),
      end: Math.max(start, end) + 1,
    }
  }

  clearSelection() {
    const hadSelection = this.selection !== null
    this.selection = null
    return hadSelection
  }

  private move(delta: number, select = false) {
    const start = this.cursorOffset
    this.cursorOffset = Math.max(
      0,
      Math.min(this.plainText.length, start + delta),
    )
    if (select) this.setSelectionInclusive(start, this.cursorOffset)
    return this.cursorOffset !== start
  }

  moveCursorLeft(options?: { select?: boolean }) {
    return this.move(-1, options?.select)
  }

  moveCursorRight(options?: { select?: boolean }) {
    return this.move(1, options?.select)
  }

  moveCursorUp(options?: { select?: boolean }) {
    return this.move(-1, options?.select)
  }

  moveCursorDown(options?: { select?: boolean }) {
    return this.move(1, options?.select)
  }

  moveWordForward(options?: { select?: boolean }) {
    return this.move(1, options?.select)
  }

  moveWordBackward(options?: { select?: boolean }) {
    return this.move(-1, options?.select)
  }

  replaceText(text: string) {
    this.plainText = text
    this.replacements++
  }

  setText(text: string) {
    this.plainText = text
  }

  undo() {
    return true
  }

  redo() {
    return true
  }
}

const effects = { dispatch() {}, writeClipboard() {} }

function run(
  editor: FakeEditor,
  actions: Parameters<typeof runActions>[1],
  register: Register = { value: "", linewise: false },
  actionEffects: Parameters<typeof runActions>[5] = effects,
) {
  runActions(
    editor,
    actions,
    register,
    createVimState("normal"),
    createVimHistory(editor.plainText),
    actionEffects,
  )
  return register
}

describe("editor action adapter", () => {
  test("line bounds distinguish offset zero, newline edges, and the trailing empty line", () => {
    expect(lineBounds("\na\n", 0)).toEqual({ start: 0, end: 0 })
    expect(lineBounds("\na\n", 1)).toEqual({ start: 1, end: 2 })
    expect(lineBounds("\na\n", 2)).toEqual({ start: 1, end: 2 })
    expect(lineBounds("\na\n", 3)).toEqual({ start: 3, end: 3 })
    expect(lineRange("a\n", 2, 1)).toEqual({ start: 2, end: 2 })
  })

  test("a counted delete is one replacement so one undo restores the Vim command", () => {
    const editor = new FakeEditor("abcd")
    editor.cursorOffset = 1
    run(editor, [{ type: "delete-char", backward: false, count: 2 }])
    expect(editor.plainText).toBe("ad")
    expect(editor.replacements).toBe(1)
  })

  test("one undo and redo restore a complete Vim command", () => {
    const editor = new FakeEditor("one\ntwo\nthree")
    editor.cursorOffset = 9
    const history = createVimHistory(editor.plainText)
    const register = { value: "", linewise: false }
    const state = createVimState("normal")
    runActions(
      editor,
      [
        {
          type: "operator-motion",
          operator: "delete",
          key: "gg",
          count: 1,
        },
      ],
      register,
      state,
      history,
      effects,
    )
    expect(editor.plainText).toBe("")
    runActions(editor, [{ type: "undo" }], register, state, history, effects)
    expect(editor.plainText).toBe("one\ntwo\nthree")
    runActions(editor, [{ type: "redo" }], register, state, history, effects)
    expect(editor.plainText).toBe("")
  })

  test("character edits follow grapheme boundaries so emoji are never split", () => {
    const forward = new FakeEditor("a😀éb")
    forward.cursorOffset = 1
    const register = run(forward, [
      { type: "delete-char", backward: false, count: 1 },
    ])
    expect(forward.plainText).toBe("aéb")
    expect(register.value).toBe("😀")

    const backward = new FakeEditor("a😀éb")
    backward.cursorOffset = 3
    run(backward, [{ type: "delete-char", backward: true, count: 1 }])
    expect(backward.plainText).toBe("aéb")

    const replace = new FakeEditor("😀éb")
    run(replace, [{ type: "replace", text: "x", count: 2 }])
    expect(replace.plainText).toBe("xxb")
    expect(replace.cursorOffset).toBe(1)
  })

  test("replace stops at the line end and leaves the cursor on the replacement", () => {
    const editor = new FakeEditor("ab\ncd")
    editor.cursorOffset = 1
    run(editor, [{ type: "replace", text: "x", count: 4 }])
    expect(editor.plainText).toBe("ax\ncd")
    expect(editor.cursorOffset).toBe(1)
  })

  test("vertical operator motions include both logical lines and set a linewise register", () => {
    const editor = new FakeEditor("one\ntwo\nthree")
    editor.cursorOffset = 5
    const register = run(editor, [
      { type: "operator-motion", operator: "delete", key: "j", count: 1 },
    ])
    expect(register).toEqual({ value: "two\nthree", linewise: true })
    expect(editor.plainText).toBe("one")
    expect(editor.replacements).toBe(1)
  })

  test("linewise yank keeps Vim's target column and copies a complete line", () => {
    const editor = new FakeEditor("  one\n  two\n  three")
    editor.cursorOffset = 9
    const copied: string[] = []
    const register = run(
      editor,
      [{ type: "operator-motion", operator: "yank", key: "k", count: 1 }],
      { value: "", linewise: false },
      {
        dispatch() {},
        writeClipboard: (text) => {
          copied.push(text)
        },
      },
    )
    expect(register).toEqual({ value: "  one\n  two", linewise: true })
    expect(editor.cursorOffset).toBe(3)
    expect(copied).toEqual(["  one\n  two\n"])

    const sameLine = new FakeEditor("  one\n  two")
    sameLine.cursorOffset = 9
    run(sameLine, [{ type: "operator-line", operator: "yank", count: 1 }])
    expect(sameLine.cursorOffset).toBe(9)
  })

  test("linewise upward yank never restores the cursor inside a grapheme", () => {
    const editor = new FakeEditor("😀z\nab")
    editor.cursorOffset = 5
    run(editor, [
      { type: "operator-motion", operator: "yank", key: "k", count: 1 },
    ])
    expect(editor.cursorOffset).toBe(0)
  })

  test("buffer-start operator motions edit complete lines atomically", () => {
    const editor = new FakeEditor("one\ntwo\nthree")
    editor.cursorOffset = 9
    const register = run(editor, [
      { type: "operator-motion", operator: "delete", key: "gg", count: 1 },
    ])
    expect(register).toEqual({ value: "one\ntwo\nthree", linewise: true })
    expect(editor.plainText).toBe("")
    expect(editor.replacements).toBe(1)
  })

  test("gg and G land at the first nonblank instead of column zero", () => {
    const editor = new FakeEditor("  first\n\tsecond\n   last")
    editor.cursorOffset = 10
    run(editor, [{ type: "motion", key: "gg", count: 1 }])
    expect(editor.cursorOffset).toBe(2)
    run(editor, [{ type: "motion", key: "G", count: 1 }])
    expect(editor.cursorOffset).toBe(19)
  })

  test("a counted join creates one undo point for the complete command", () => {
    const editor = new FakeEditor("one\n  two\nthree")
    run(editor, [{ type: "join-lines", count: 2 }])
    expect(editor.plainText).toBe("one two three")
    expect(editor.replacements).toBe(1)
  })

  test("linewise paste preserves empty and unterminated logical lines", () => {
    const emptyLine = new FakeEditor("tail")
    run(emptyLine, [{ type: "paste", before: true, count: 2 }], {
      value: "",
      linewise: true,
    })
    expect(emptyLine.plainText).toBe("\n\ntail")

    const finalLine = new FakeEditor("head")
    run(finalLine, [{ type: "paste", before: false, count: 2 }], {
      value: "last",
      linewise: true,
    })
    expect(finalLine.plainText).toBe("head\nlast\nlast")
    expect(finalLine.cursorOffset).toBe(5)
  })

  test("characterwise paste ends on the last inserted character", () => {
    const editor = new FakeEditor("ac")
    run(editor, [{ type: "paste", before: false, count: 2 }], {
      value: "b",
      linewise: false,
    })
    expect(editor.plainText).toBe("abbc")
    expect(editor.cursorOffset).toBe(2)
  })

  test("characterwise paste leaves the cursor on a complete pasted grapheme", () => {
    const editor = new FakeEditor("ab")
    run(editor, [{ type: "paste", before: false, count: 1 }], {
      value: "😀",
      linewise: false,
    })
    expect(editor.plainText).toBe("a😀b")
    expect(editor.cursorOffset).toBe(1)
  })

  test("characterwise paste inserts after a complete cursor grapheme", () => {
    const editor = new FakeEditor("a😀b")
    editor.cursorOffset = 1
    run(editor, [{ type: "paste", before: false, count: 1 }], {
      value: "x",
      linewise: false,
    })
    expect(editor.plainText).toBe("a😀xb")
    expect(editor.cursorOffset).toBe(3)
  })

  test("host actions dispatch their public command IDs", () => {
    const editor = new FakeEditor("")
    const dispatched: string[] = []
    run(
      editor,
      [
        { type: "command", id: "session.timeline" },
        { type: "submit" },
        { type: "palette" },
      ],
      { value: "", linewise: false },
      {
        dispatch: (id) => {
          dispatched.push(id)
        },
        writeClipboard() {},
      },
    )
    expect(dispatched).toEqual([
      "session.timeline",
      "input.submit",
      "command.palette.show",
    ])
  })

  test("visual yank returns the cursor to the ordered selection start", () => {
    const editor = new FakeEditor("abcd")
    editor.selection = { start: 1, end: 3 }
    editor.cursorOffset = 2
    const register = run(editor, [
      { type: "visual-operator", operator: "yank", linewise: false },
    ])
    expect(register.value).toBe("bc")
    expect(editor.cursorOffset).toBe(1)
  })

  test("visual-line delete removes the separator before a final unterminated line", () => {
    const editor = new FakeEditor("first\nlast")
    editor.selection = { start: 6, end: 10 }
    const register = run(editor, [
      { type: "visual-operator", operator: "delete", linewise: true },
    ])
    expect(register).toEqual({ value: "last", linewise: true })
    expect(editor.plainText).toBe("first")
  })
})
