import { describe, expect, test } from "bun:test"
import {
  beginInsertSession,
  createVimHistory,
  finalizeInsertSession,
  insertHostText,
  lineBounds,
  lineRange,
  type Register,
  runActions,
  syncVisualState,
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

  insertText(text: string) {
    const selection = this.getSelection()
    const start = selection?.start ?? this.cursorOffset
    const end = selection?.end ?? this.cursorOffset
    this.replaceText(
      this.plainText.slice(0, start) + text + this.plainText.slice(end),
    )
    this.cursorOffset = start + text.length
    this.clearSelection()
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

function mutableEffects(runtime = createVimState("normal")) {
  return {
    dispatch() {},
    writeClipboard() {},
    transitionRuntime(mutation: (state: typeof runtime) => void) {
      mutation(runtime)
    },
  }
}

const effects = mutableEffects()

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

  test("replace fails atomically when its count crosses the line end", () => {
    const editor = new FakeEditor("ab\ncd")
    editor.cursorOffset = 1
    run(editor, [{ type: "replace", text: "x", count: 4 }])
    expect(editor.plainText).toBe("ab\ncd")
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
        transitionRuntime: effects.transitionRuntime,
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
    run(editor, [{ type: "join-lines", count: 3 }])
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
        transitionRuntime: effects.transitionRuntime,
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

  test("visual endpoints survive reversed motions and swap explicitly", () => {
    const editor = new FakeEditor("abcdef")
    editor.cursorOffset = 4
    const runtime = createVimState("visual")
    runtime.visual = { kind: "character", anchor: 4, active: 4 }
    editor.setSelectionInclusive(4, 4)
    const history = createVimHistory(editor.plainText)
    const register = { value: "", linewise: false }
    const actionEffects = mutableEffects(runtime)

    runActions(
      editor,
      [{ type: "motion", key: "h", count: 2 }],
      register,
      runtime,
      history,
      actionEffects,
    )
    expect(runtime.visual).toEqual({
      kind: "character",
      anchor: 4,
      active: 2,
    })
    runActions(
      editor,
      [{ type: "visual-swap" }, { type: "motion", key: "l", count: 1 }],
      register,
      runtime,
      history,
      actionEffects,
    )
    expect(runtime.visual).toEqual({
      kind: "character",
      anchor: 2,
      active: 5,
    })
    runActions(
      editor,
      [{ type: "visual-operator", operator: "delete", linewise: false }],
      register,
      runtime,
      history,
      actionEffects,
    )
    expect(editor.plainText).toBe("ab")
    expect(register).toEqual({ value: "cdef", linewise: false })
    expect(history.undo).toHaveLength(1)
  })

  test("character finds stay on their line and failed changes preserve normal mode", () => {
    const editor = new FakeEditor("😀a,x,x\nnext,x")
    editor.cursorOffset = 0
    run(editor, [
      {
        type: "find",
        find: { direction: "forward", till: false, target: "x" },
        count: 2,
      },
    ])
    expect(editor.cursorOffset).toBe(6)

    const state = createVimState("normal")
    runActions(
      editor,
      [
        {
          type: "find",
          find: { direction: "forward", till: false, target: "z" },
          count: 1,
          operator: "change",
        },
      ],
      { value: "", linewise: false },
      state,
      createVimHistory(editor.plainText),
      mutableEffects(state),
    )
    expect(editor.plainText).toBe("😀a,x,x\nnext,x")
    expect(state.mode).toBe("normal")
  })

  test("matching delimiters and nested text objects resolve complete graphemes", () => {
    const match = new FakeEditor("😀({a[b]}) tail")
    match.cursorOffset = 2
    run(match, [{ type: "motion", key: "%", count: 1 }])
    expect(match.cursorOffset).toBe(9)

    const nested = new FakeEditor("x (one {😀 two} three) y")
    nested.cursorOffset = 9
    const register = run(nested, [
      {
        type: "text-object",
        object: "brace",
        around: false,
        count: 1,
        operator: "yank",
      },
    ])
    expect(register.value).toBe("😀 two")
    expect(nested.cursorOffset).toBe(8)
  })

  test("word objects distinguish punctuation and surrounding whitespace", () => {
    const inner = new FakeEditor("one,   two")
    const innerRegister = run(inner, [
      {
        type: "text-object",
        object: "word",
        around: false,
        count: 2,
        operator: "delete",
      },
    ])
    expect(innerRegister.value).toBe("one,")
    expect(inner.plainText).toBe("   two")

    const around = new FakeEditor("one   two")
    run(around, [
      {
        type: "text-object",
        object: "word",
        around: true,
        count: 1,
        operator: "delete",
      },
    ])
    expect(around.plainText).toBe("two")
  })

  test("failed visual text objects preserve the selection and mode", () => {
    const editor = new FakeEditor("plain text")
    editor.selection = { start: 0, end: 5 }
    editor.cursorOffset = 4
    const state = createVimState("visual")
    state.visual = { kind: "character", anchor: 0, active: 4 }
    runActions(
      editor,
      [
        {
          type: "text-object",
          object: "double-quote",
          around: false,
          count: 1,
        },
      ],
      { value: "", linewise: false },
      state,
      createVimHistory(editor.plainText),
      mutableEffects(state),
    )
    expect(editor.selection).toEqual({ start: 0, end: 5 })
    expect(state.mode).toBe("visual")
  })

  test("reversed visual word objects keep the original anchor and active direction", () => {
    const editor = new FakeEditor("one two")
    editor.cursorOffset = 4
    editor.setSelectionInclusive(5, 4)
    const state = createVimState("visual")
    state.visual = { kind: "character", anchor: 5, active: 4 }

    runActions(
      editor,
      [
        {
          type: "text-object",
          object: "word",
          around: false,
          count: 1,
        },
      ],
      { value: "", linewise: false },
      state,
      createVimHistory(editor.plainText),
      mutableEffects(state),
    )

    expect(state.visual).toEqual({
      kind: "character",
      anchor: 5,
      active: 3,
    })
    expect(editor.selection).toEqual({ start: 3, end: 6 })
    expect(editor.cursorOffset).toBe(3)
  })

  test("visual paste records deletion shape for dot instead of another paste", () => {
    const editor = new FakeEditor("abcdef")
    editor.cursorOffset = 2
    editor.setSelectionInclusive(1, 2)
    const state = createVimState("visual")
    state.visual = { kind: "character", anchor: 1, active: 2 }
    const history = createVimHistory(editor.plainText)
    const register = { value: "XY", linewise: false }

    runActions(
      editor,
      [{ type: "visual-paste", preserveRegister: true, count: 1 }],
      register,
      state,
      history,
      mutableEffects(state),
    )

    expect(editor.plainText).toBe("aXYdef")
    expect(history.lastChange).toEqual({
      actions: [
        {
          type: "visual-operator",
          operator: "delete",
          linewise: false,
          shape: {
            graphemes: 2,
            lines: 1,
            endColumn: 3,
            linewise: false,
          },
          preserveRegister: true,
        },
      ],
    })
  })

  test("valid no-op visual outdent and join still leave visual mode", () => {
    for (const action of [
      { type: "visual-indent", direction: "left", count: 1 } as const,
      { type: "visual-join" } as const,
    ]) {
      const editor = new FakeEditor("abc")
      editor.cursorOffset = 1
      editor.setSelectionInclusive(0, 1)
      const state = createVimState("visual")
      state.visual = { kind: "character", anchor: 0, active: 1 }
      runActions(
        editor,
        [action],
        { value: "", linewise: false },
        state,
        createVimHistory(editor.plainText),
        mutableEffects(state),
      )
      expect(state.mode).toBe("normal")
      expect(editor.selection).toBeNull()
    }
  })

  test("no-op linewise outdent and characterwise join return to the visual start", () => {
    const outdent = new FakeEditor("aa\nbb\ncc")
    outdent.cursorOffset = 4
    outdent.setSelection(0, 6)
    const outdentState = createVimState("visual")
    outdentState.visual = { kind: "line", anchor: 4, active: 1 }
    runActions(
      outdent,
      [{ type: "visual-indent", direction: "left", count: 1 }],
      { value: "", linewise: false },
      outdentState,
      createVimHistory(outdent.plainText),
      mutableEffects(outdentState),
    )
    expect(outdent.cursorOffset).toBe(1)

    const join = new FakeEditor("abcdef")
    join.cursorOffset = 3
    join.setSelectionInclusive(2, 3)
    const joinState = createVimState("visual")
    joinState.visual = { kind: "character", anchor: 2, active: 3 }
    runActions(
      join,
      [{ type: "visual-join" }],
      { value: "", linewise: false },
      joinState,
      createVimHistory(join.plainText),
      mutableEffects(joinState),
    )
    expect(join.cursorOffset).toBe(2)
  })

  test("visual case uses simple Unicode mappings without full-case expansion", () => {
    const editor = new FakeEditor("ßﬀAİ")
    editor.cursorOffset = 2
    editor.setSelection(0, editor.plainText.length)
    const state = createVimState("visual")
    state.visual = { kind: "character", anchor: 0, active: 2 }
    runActions(
      editor,
      [{ type: "visual-case" }],
      { value: "", linewise: false },
      state,
      createVimHistory(editor.plainText),
      mutableEffects(state),
    )
    expect(editor.plainText).toBe("ẞﬀai")
  })

  test("visual state reanchors on editor focus and follows native selection changes", () => {
    const first = new FakeEditor("first")
    const second = new FakeEditor("second")
    second.cursorOffset = 3
    const state = createVimState("visual")
    state.visual = { kind: "character", anchor: 4, active: 2 }
    const actionEffects = mutableEffects(state)

    syncVisualState(second, state, actionEffects, true)
    expect(state.visual).toEqual({
      kind: "character",
      anchor: 3,
      active: 3,
    })
    expect(second.selection).toEqual({ start: 3, end: 4 })
    expect(first.selection).toBeNull()

    second.cursorOffset = 1
    second.setSelectionInclusive(1, 4)
    syncVisualState(second, state, actionEffects, false)
    expect(state.visual).toEqual({
      kind: "character",
      anchor: 4,
      active: 1,
    })

    second.clearSelection()
    syncVisualState(second, state, actionEffects, false)
    expect(state.mode).toBe("normal")
    expect(state.visual).toBeNull()
  })

  test("backward native line selection keeps its real cursor as the active end", () => {
    const editor = new FakeEditor("aa\nbb\ncc")
    editor.setSelection(0, 6)
    editor.cursorOffset = 1
    const state = createVimState("visual")
    state.visual = { kind: "line", anchor: 1, active: 4 }

    syncVisualState(editor, state, mutableEffects(state), false)

    expect(state.visual).toEqual({ kind: "line", anchor: 3, active: 1 })
  })

  test("runtime updates go through effects without mutating a frozen store", () => {
    const editor = new FakeEditor('"one"')
    editor.cursorOffset = 2
    const runtime = Object.freeze({
      ...createVimState("visual"),
      pending: Object.freeze({ type: "none" as const, count: 0 }),
      visual: Object.freeze({ kind: "line" as const, anchor: 0, active: 0 }),
    })
    const next = createVimState("visual")
    next.visual = { kind: "line", anchor: 0, active: 0 }
    let transitions = 0

    runActions(
      editor,
      [
        {
          type: "text-object",
          object: "double-quote",
          around: false,
          count: 1,
        },
      ],
      { value: "", linewise: false },
      runtime,
      createVimHistory(editor.plainText),
      {
        dispatch() {},
        writeClipboard() {},
        transitionRuntime(mutation) {
          transitions++
          mutation(next)
        },
      },
    )

    expect(transitions).toBe(1)
    expect(runtime.visual?.kind).toBe("line")
    expect(next.visual?.kind).toBe("character")
  })

  test("repeats normal changes semantically and keeps each repeat atomic", () => {
    const editor = new FakeEditor("abcdef")
    const runtime = createVimState("normal")
    const history = createVimHistory(editor.plainText)
    const register = { value: "", linewise: false }
    const actionEffects = mutableEffects(runtime)

    runActions(
      editor,
      [{ type: "delete-char", backward: false, count: 1 }],
      register,
      runtime,
      history,
      actionEffects,
    )
    editor.cursorOffset = 1
    runActions(
      editor,
      [{ type: "repeat", count: 2 }],
      register,
      runtime,
      history,
      actionEffects,
    )
    expect(editor.plainText).toBe("bef")
    expect(register.value).toBe("cd")

    runActions(
      editor,
      [{ type: "undo" }],
      register,
      runtime,
      history,
      actionEffects,
    )
    expect(editor.plainText).toBe("bcdef")
  })

  test("captures host insert text between public mode transitions", () => {
    const editor = new FakeEditor("one two")
    const runtime = createVimState("normal")
    const history = createVimHistory(editor.plainText)
    const register = { value: "", linewise: false }
    const actionEffects = mutableEffects(runtime)

    runtime.mode = "insert"
    beginInsertSession(editor, history)
    editor.replaceText("Xone two")
    editor.cursorOffset = 1
    runtime.mode = "normal"
    runActions(
      editor,
      [{ type: "mode", mode: "normal" }],
      register,
      runtime,
      history,
      actionEffects,
    )
    editor.cursorOffset = 5
    runActions(
      editor,
      [{ type: "repeat" }],
      register,
      runtime,
      history,
      actionEffects,
    )
    expect(editor.plainText).toBe("Xone Xtwo")

    runActions(
      editor,
      [{ type: "undo" }],
      register,
      runtime,
      history,
      actionEffects,
    )
    expect(editor.plainText).toBe("Xone two")

    runActions(
      editor,
      [{ type: "undo" }],
      register,
      runtime,
      history,
      actionEffects,
    )
    expect(editor.plainText).toBe("one two")
  })

  test("anchors captured insertion at the session cursor when neighboring text is identical", () => {
    const editor = new FakeEditor("foo foo")
    const runtime = createVimState("normal")
    const history = createVimHistory(editor.plainText)
    const register = { value: "", linewise: false }
    const actionEffects = mutableEffects(runtime)

    runtime.mode = "insert"
    beginInsertSession(editor, history)
    editor.insertText("foo ")
    runtime.mode = "normal"
    runActions(
      editor,
      [{ type: "mode", mode: "normal" }],
      register,
      runtime,
      history,
      actionEffects,
    )
    editor.cursorOffset = 8
    runActions(
      editor,
      [{ type: "repeat" }],
      register,
      runtime,
      history,
      actionEffects,
    )

    expect(editor.plainText).toBe("foo foo foo foo")
  })

  test("does not apply captured insertion when a repeated text object fails", () => {
    const editor = new FakeEditor('"one" plain')
    editor.cursorOffset = 1
    const runtime = createVimState("normal")
    const history = createVimHistory(editor.plainText)
    const register = { value: "", linewise: false }
    const actionEffects = mutableEffects(runtime)

    runActions(
      editor,
      [
        {
          type: "text-object",
          object: "double-quote",
          around: false,
          count: 1,
          operator: "change",
        },
      ],
      register,
      runtime,
      history,
      actionEffects,
    )
    editor.insertText("X")
    runtime.mode = "normal"
    runActions(
      editor,
      [{ type: "mode", mode: "normal" }],
      register,
      runtime,
      history,
      actionEffects,
    )
    editor.cursorOffset = 4
    runActions(
      editor,
      [{ type: "repeat" }],
      register,
      runtime,
      history,
      actionEffects,
    )

    expect(editor.plainText).toBe('"X" plain')
  })

  test("keeps visual change, host insertion, and undo in one session", () => {
    const editor = new FakeEditor("one two")
    editor.setSelection(0, 3)
    editor.cursorOffset = 2
    const runtime = createVimState("visual")
    runtime.visual = { kind: "character", anchor: 0, active: 0 }
    const history = createVimHistory(editor.plainText)
    const register = { value: "", linewise: false }
    const actionEffects = mutableEffects(runtime)

    runActions(
      editor,
      [{ type: "visual-operator", operator: "change", linewise: false }],
      register,
      runtime,
      history,
      actionEffects,
    )
    expect(runtime.mode).toBe("insert")
    expect(history.changeSession?.before.text).toBe("one two")
    editor.insertText("one")
    runtime.mode = "normal"
    runActions(
      editor,
      [{ type: "mode", mode: "normal" }],
      register,
      runtime,
      history,
      actionEffects,
    )

    expect(history.undo).toHaveLength(1)
    runActions(
      editor,
      [{ type: "undo" }],
      register,
      runtime,
      history,
      actionEffects,
    )
    expect(editor.plainText).toBe("one two")
    expect(history.undo).toHaveLength(0)
  })

  test("starts a host-prefix insert session synchronously for each editor", () => {
    const first = new FakeEditor("one")
    const second = new FakeEditor("two")
    const firstHistory = createVimHistory(first.plainText)
    const secondHistory = createVimHistory(second.plainText)

    insertHostText(first, firstHistory, "/")
    insertHostText(second, secondHistory, "/")

    expect(firstHistory.changeSession?.before.text).toBe("one")
    expect(secondHistory.changeSession?.before.text).toBe("two")
    expect(first.plainText).toBe("/one")
    expect(second.plainText).toBe("/two")
  })

  test("finalizes editor A before editor B starts so A can repeat and undo its insert", () => {
    const first = new FakeEditor("one")
    const second = new FakeEditor("two")
    const firstHistory = createVimHistory(first.plainText)
    const secondHistory = createVimHistory(second.plainText)
    const runtime = createVimState("normal")
    const register = { value: "", linewise: false }

    insertHostText(first, firstHistory, "/")
    finalizeInsertSession(first, firstHistory)
    insertHostText(second, secondHistory, "/")

    expect(firstHistory.changeSession).toBeNull()
    expect(firstHistory.undo).toHaveLength(1)
    expect(firstHistory.lastChange).not.toBeNull()

    first.cursorOffset = first.plainText.length
    runActions(
      first,
      [{ type: "repeat" }],
      register,
      runtime,
      firstHistory,
      mutableEffects(runtime),
    )
    expect(first.plainText).toBe("/on/e")
    runActions(
      first,
      [{ type: "undo" }],
      register,
      runtime,
      firstHistory,
      mutableEffects(runtime),
    )
    expect(first.plainText).toBe("/one")
  })

  test("a counted replacement repeat fails atomically when the line is too short", () => {
    const editor = new FakeEditor("a😀é")
    const runtime = createVimState("normal")
    const history = createVimHistory(editor.plainText)
    const register = { value: "", linewise: false }
    const actionEffects = mutableEffects(runtime)

    runActions(
      editor,
      [{ type: "replace", text: "z", count: 1 }],
      register,
      runtime,
      history,
      actionEffects,
    )
    editor.cursorOffset = 1
    runActions(
      editor,
      [{ type: "repeat", count: 3 }],
      register,
      runtime,
      history,
      actionEffects,
    )

    expect(editor.plainText).toBe("z😀é")
    expect(history.undo).toHaveLength(1)
    runActions(
      editor,
      [{ type: "undo" }],
      register,
      runtime,
      history,
      actionEffects,
    )
    expect(editor.plainText).toBe("a😀é")
  })

  test("D on an empty line creates no transaction or undo point", () => {
    const editor = new FakeEditor("a\n")
    const runtime = createVimState("normal")
    const history = createVimHistory(editor.plainText)
    const register = { value: "", linewise: false }
    const actionEffects = mutableEffects(runtime)

    runActions(
      editor,
      [{ type: "delete-char", backward: false, count: 1 }],
      register,
      runtime,
      history,
      actionEffects,
    )
    runActions(
      editor,
      [{ type: "operator-motion", operator: "delete", key: "$", count: 1 }],
      register,
      runtime,
      history,
      actionEffects,
    )
    expect(editor.plainText).toBe("\n")
    expect(history.undo).toHaveLength(1)

    runActions(
      editor,
      [{ type: "undo" }],
      register,
      runtime,
      history,
      actionEffects,
    )
    expect(editor.plainText).toBe("a\n")
  })

  test("yanks, motions, failed edits, and undo do not replace the last change", () => {
    const editor = new FakeEditor("abcd")
    const runtime = createVimState("normal")
    const history = createVimHistory(editor.plainText)
    const register = { value: "", linewise: false }
    const actionEffects = mutableEffects(runtime)
    const execute = (actions: Parameters<typeof runActions>[1]) =>
      runActions(editor, actions, register, runtime, history, actionEffects)

    execute([{ type: "replace", text: "z", count: 1 }])
    execute([{ type: "motion", key: "l", count: 1 }])
    execute([{ type: "operator-line", operator: "yank", count: 1 }])
    editor.cursorOffset = editor.plainText.length
    execute([{ type: "delete-char", backward: false, count: 1 }])
    execute([{ type: "undo" }])
    editor.cursorOffset = 1
    execute([{ type: "repeat" }])
    expect(editor.plainText).toBe("azcd")
  })

  test("dot paste reads the current unnamed register", () => {
    const editor = new FakeEditor("ac")
    const runtime = createVimState("normal")
    const history = createVimHistory(editor.plainText)
    const register = { value: "b", linewise: false }
    const actionEffects = mutableEffects(runtime)
    runActions(
      editor,
      [{ type: "paste", before: false, count: 1 }],
      register,
      runtime,
      history,
      actionEffects,
    )
    register.value = "z"
    runActions(
      editor,
      [{ type: "repeat" }],
      register,
      runtime,
      history,
      actionEffects,
    )
    expect(editor.plainText).toBe("abzc")
  })

  test("a successful no-op replacement still becomes the last change", () => {
    const editor = new FakeEditor("ab")
    const runtime = createVimState("normal")
    const history = createVimHistory(editor.plainText)
    const register = { value: "", linewise: false }
    const actionEffects = mutableEffects(runtime)
    runActions(
      editor,
      [{ type: "replace", text: "a", count: 1 }],
      register,
      runtime,
      history,
      actionEffects,
    )
    expect(history.undo).toHaveLength(1)
    expect(history.lastChange).toEqual({
      actions: [{ type: "replace", text: "a", count: 1 }],
    })
    editor.cursorOffset = 1
    runActions(
      editor,
      [{ type: "repeat" }],
      register,
      runtime,
      history,
      actionEffects,
    )
    expect(editor.plainText).toBe("aa")
  })
})
