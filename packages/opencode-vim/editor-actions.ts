import type {
  CharacterFind,
  EnterKey,
  MotionKey,
  Operator,
  TextObject,
  VimAction,
  VimState,
  VisualShape,
} from "./engine.ts"

export type Register = { value: string; linewise: boolean }
type Snapshot = {
  text: string
  cursor: number
  selection: { start: number; end: number } | null
}
type TextEdit = {
  startDelta: number
  deleteCount: number
  text: string
  cursorDelta: number
}
export type RepeatDescriptor = {
  actions: VimAction[]
  edit?: TextEdit
}
type ChangeSession = {
  before: Snapshot
  actions: VimAction[]
  baseline: Snapshot
}
export type VimHistory = {
  undo: Snapshot[]
  redo: Snapshot[]
  currentText: string
  lastChange: RepeatDescriptor | null
  changeSession: ChangeSession | null
}

// A thousand complete changes keeps practical undo depth without unbounded prompt retention.
const HISTORY_DEPTH = 1_000

function trimSnapshots(stack: Snapshot[]) {
  if (stack.length > HISTORY_DEPTH)
    stack.splice(0, stack.length - HISTORY_DEPTH)
}

function pushSnapshot(stack: Snapshot[], snapshot: Snapshot) {
  stack.push(snapshot)
  trimSnapshots(stack)
}

export function createVimHistory(text = ""): VimHistory {
  return {
    undo: [],
    redo: [],
    currentText: text,
    lastChange: null,
    changeSession: null,
  }
}

export function syncVimHistory(history: VimHistory, text: string) {
  if (history.currentText === text) return
  if (history.changeSession) {
    history.currentText = text
    return
  }
  history.undo.length = 0
  history.redo.length = 0
  history.currentText = text
}

export function beginInsertSession(editor: VimEditor, history: VimHistory) {
  if (history.changeSession) return
  const snapshot = snapshotOf(editor)
  history.changeSession = {
    before: snapshot,
    actions: [{ type: "enter", key: "i", count: 1 }],
    baseline: snapshot,
  }
  history.currentText = editor.plainText
}

export function insertHostText(
  editor: VimEditor & { insertText(text: string): void },
  history: VimHistory,
  text: string,
) {
  syncVimHistory(history, editor.plainText)
  beginInsertSession(editor, history)
  editor.insertText(text)
  history.currentText = editor.plainText
}

export function finalizeInsertSession(editor: VimEditor, history: VimHistory) {
  const session = history.changeSession
  if (!session) return
  const exit = snapshotOf(editor)
  if (
    exit.text !== session.baseline.text ||
    session.baseline.text !== session.before.text
  ) {
    pushSnapshot(history.undo, session.before)
    history.redo.length = 0
    history.lastChange = {
      actions: session.actions.map((action) => ({ ...action })),
      edit: hostEdit(session.baseline, exit),
    }
  }
  history.changeSession = null
  history.currentText = editor.plainText
}

function snapshotOf(editor: VimEditor): Snapshot {
  const selection = editor.getSelection()
  return {
    text: editor.plainText,
    cursor: editor.cursorOffset,
    selection: selection ? { ...selection } : null,
  }
}

export interface VimEditor {
  plainText: string
  cursorOffset: number
  lineCount: number
  hasSelection(): boolean
  getSelection(): { start: number; end: number } | null
  setSelection(start: number, end: number): void
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
  openEx(): void
  writeClipboard(text: string): void
  transitionRuntime(mutation: (runtime: VimState) => void): void
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

function nextGraphemeStart(text: string, offset: number, limit = text.length) {
  return Math.min(advanceGraphemes(text, offset, 1, limit), limit)
}

function setGraphemeInclusiveSelection(
  editor: VimEditor,
  start: number,
  end: number,
) {
  editor.setSelection(
    Math.min(start, end),
    nextGraphemeStart(editor.plainText, Math.max(start, end)),
  )
}

function selectionAnchor(editor: VimEditor) {
  const selection = editor.getSelection()
  if (!selection) return editor.cursorOffset
  if (editor.cursorOffset <= selection.start)
    return retreatGraphemes(editor.plainText, selection.end, 1, selection.start)
  return selection.start
}

function selectTo(editor: VimEditor, target: number) {
  setGraphemeInclusiveSelection(editor, selectionAnchor(editor), target)
  editor.cursorOffset = target
}

function renderVisualEndpoints(
  editor: VimEditor,
  kind: "character" | "line",
  anchor: number,
  active: number,
) {
  if (kind === "line") {
    const first = Math.min(
      lineBounds(editor.plainText, anchor).start,
      lineBounds(editor.plainText, active).start,
    )
    const last = Math.max(
      lineBounds(editor.plainText, anchor).start,
      lineBounds(editor.plainText, active).start,
    )
    editor.setSelection(first, lineRange(editor.plainText, last, 1).end)
  } else setGraphemeInclusiveSelection(editor, anchor, active)
  editor.cursorOffset = active
}

function renderedVisualRange(
  editor: VimEditor,
  kind: "character" | "line",
  anchor: number,
  active: number,
) {
  if (kind === "line") {
    const first = Math.min(
      lineBounds(editor.plainText, anchor).start,
      lineBounds(editor.plainText, active).start,
    )
    const last = Math.max(
      lineBounds(editor.plainText, anchor).start,
      lineBounds(editor.plainText, active).start,
    )
    return { start: first, end: lineRange(editor.plainText, last, 1).end }
  }
  return {
    start: Math.min(anchor, active),
    end: nextGraphemeStart(editor.plainText, Math.max(anchor, active)),
  }
}

function updateVisualEndpoints(
  effects: ActionEffects,
  anchor: number,
  active: number,
) {
  effects.transitionRuntime((next) => {
    if (!next.visual) return
    next.visual.anchor = anchor
    next.visual.active = active
  })
}

export function syncVisualState(
  editor: VimEditor,
  runtime: VimState,
  effects: ActionEffects,
  reset: boolean,
) {
  const visual = runtime.mode === "visual" ? runtime.visual : null
  if (!visual) return false
  if (reset) {
    const endpoint = editor.cursorOffset
    renderVisualEndpoints(editor, visual.kind, endpoint, endpoint)
    updateVisualEndpoints(effects, endpoint, endpoint)
    return true
  }

  const selection = editor.getSelection()
  if (!selection) {
    leaveVisual(effects)
    return true
  }
  if (visual.anchor === null || visual.active === null) return false
  const expected = renderedVisualRange(
    editor,
    visual.kind,
    visual.anchor,
    visual.active,
  )
  if (
    selection.start === expected.start &&
    selection.end === expected.end &&
    editor.cursorOffset === visual.active
  )
    return false

  const first =
    visual.kind === "line"
      ? lineBounds(editor.plainText, selection.start).start
      : selection.start
  const lastOffset = retreatGraphemes(
    editor.plainText,
    selection.end,
    1,
    selection.start,
  )
  const last =
    visual.kind === "line"
      ? lineBounds(editor.plainText, lastOffset).start
      : lastOffset
  const cursorLine =
    visual.kind === "line"
      ? lineBounds(editor.plainText, editor.cursorOffset).start
      : editor.cursorOffset
  const active = visual.kind === "line" ? editor.cursorOffset : cursorLine
  const anchor = cursorLine === first ? last : first
  updateVisualEndpoints(effects, anchor, active)
  return true
}

function visualShape(
  editor: VimEditor,
  range: { start: number; end: number },
  linewise: boolean,
): VisualShape {
  const lastOffset = Math.max(range.start, range.end - 1)
  const lastLineStart = lineBounds(editor.plainText, lastOffset).start
  return {
    graphemes: graphemeSegments(editor.plainText.slice(range.start, range.end))
      .length,
    lines: Math.max(
      1,
      rowAt(editor.plainText, Math.max(range.start, range.end - 1)) -
        rowAt(editor.plainText, range.start) +
        1,
    ),
    endColumn: graphemeSegments(
      editor.plainText.slice(lastLineStart, range.end),
    ).length,
    linewise,
  }
}

function rangeForShape(editor: VimEditor, shape: VisualShape) {
  if (shape.linewise)
    return lineRange(editor.plainText, editor.cursorOffset, shape.lines)
  if (shape.lines > 1) {
    const targetStart = rowStart(
      editor.plainText,
      Math.min(
        editor.lineCount - 1,
        rowAt(editor.plainText, editor.cursorOffset) + shape.lines - 1,
      ),
    )
    const targetEnd = lineBounds(editor.plainText, targetStart).end
    return {
      start: editor.cursorOffset,
      end: advanceGraphemes(
        editor.plainText,
        targetStart,
        shape.endColumn,
        targetEnd,
      ),
    }
  }
  const end = advanceGraphemes(
    editor.plainText,
    editor.cursorOffset,
    shape.graphemes,
  )
  return end > editor.cursorOffset ? { start: editor.cursorOffset, end } : null
}

function leaveVisual(effects: ActionEffects, insert = false) {
  effects.transitionRuntime((next) => {
    next.mode = insert || next.oneShotNormal ? "insert" : "normal"
    next.oneShotNormal = false
    next.visual = null
    next.pending = { type: "none", count: 0 }
  })
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

function endOfWord(
  text: string,
  offset: number,
  count: number,
  includeCurrentEndpoint = false,
) {
  const segments = graphemeSegments(text)
  let index = segments.findIndex((segment) => segment.index >= offset)
  if (index < 0) return Math.max(0, text.length - 1)
  const kind = (grapheme: string) => {
    if (/\s/u.test(grapheme)) return "space"
    return /[\p{L}\p{N}_]/u.test(grapheme) ? "word" : "punctuation"
  }
  for (let step = 0; step < count; step++) {
    const currentKind = kind(segments[index]?.segment ?? "")
    const nextKind = kind(segments[index + 1]?.segment ?? "")
    if (
      currentKind !== "space" &&
      nextKind !== currentKind &&
      !(includeCurrentEndpoint && step === 0)
    )
      index++
    while (
      index < segments.length &&
      kind(segments[index]?.segment ?? "") === "space"
    )
      index++
    const current = kind(segments[index]?.segment ?? "")
    while (
      index < segments.length - 1 &&
      kind(segments[index + 1]?.segment ?? "") === current
    )
      index++
  }
  return segments[Math.min(index, segments.length - 1)]?.index ?? 0
}

function bigWordDestination(
  text: string,
  offset: number,
  count: number,
  key: Extract<MotionKey, "W" | "B" | "E">,
) {
  const segments = graphemeSegments(text)
  if (segments.length === 0) return 0
  const starts: number[] = []
  const ends: number[] = []
  for (let index = 0; index < segments.length; index++) {
    const value = segments[index]!.segment
    if (value === "\n") {
      if (segments[index - 1]?.segment === "\n")
        starts.push(segments[index]!.index)
      continue
    }
    if (/\s/u.test(value)) continue
    if (index === 0 || /\s/u.test(segments[index - 1]!.segment))
      starts.push(segments[index]!.index)
    if (
      index === segments.length - 1 ||
      /\s/u.test(segments[index + 1]!.segment)
    )
      ends.push(segments[index]!.index)
  }
  const destinations = key === "E" ? ends : starts
  let destination = offset
  for (let step = 0; step < count; step++) {
    const next =
      key === "B"
        ? destinations.findLast((position) => position < destination)
        : destinations.find((position) => position > destination)
    if (next === undefined) return key === "B" ? 0 : lastGraphemeStart(text)
    destination = next
  }
  return destination
}

function matchingDelimiter(text: string, offset: number) {
  const bounds = lineBounds(text, offset)
  const pairs: Record<string, string> = {
    "(": ")",
    "[": "]",
    "{": "}",
    ")": "(",
    "]": "[",
    "}": "{",
  }
  const opening = new Set(["(", "[", "{"])
  const segments = graphemeSegments(text)
  let index = segments.findIndex(
    (segment) =>
      segment.index >= offset &&
      segment.index < bounds.end &&
      pairs[segment.segment],
  )
  if (index < 0) return null
  const delimiter = segments[index]!.segment
  const forward = opening.has(delimiter)
  const match = pairs[delimiter]!
  let depth = 0
  while (index >= 0 && index < segments.length) {
    const value = segments[index]!.segment
    if (value === delimiter) depth++
    if (value === match && --depth === 0) return segments[index]!.index
    index += forward ? 1 : -1
  }
  return null
}

function findDestination(
  text: string,
  offset: number,
  find: CharacterFind,
  count: number,
  repeat: boolean,
) {
  const bounds = lineBounds(text, offset)
  const starts = graphemeSegments(text)
    .filter(
      (segment) => segment.index >= bounds.start && segment.index < bounds.end,
    )
    .map((segment) => ({ start: segment.index, value: segment.segment }))
  let index = starts.findIndex((segment) => segment.start === offset)
  if (index < 0) return null
  const step = find.direction === "forward" ? 1 : -1
  index += step
  const matches = (value: string) => value.startsWith(find.target)
  if (repeat && find.till && matches(starts[index]?.value ?? "")) index += step
  for (let found = 0; index >= 0 && index < starts.length; index += step) {
    if (!matches(starts[index]!.value)) continue
    found++
    if (found !== count) continue
    const targetIndex = find.till ? index - step : index
    return starts[targetIndex]?.start ?? null
  }
  return null
}

type TextRange = { start: number; end: number; linewise?: boolean }

function withLinewiseIntent(text: string, range: TextRange): TextRange {
  if (
    range.start === lineBounds(text, range.start).start &&
    range.end > range.start &&
    rowAt(text, range.start) !== rowAt(text, range.end - 1) &&
    (range.end === text.length || text[range.end - 1] === "\n")
  )
    range.linewise = true
  return range
}

function wordObjectRange(
  text: string,
  offset: number,
  around: boolean,
  count: number,
): TextRange | null {
  const bounds = lineBounds(text, offset)
  const lineText = text.slice(bounds.start, bounds.end)
  if (text.length === 0) return { start: 0, end: 0 }
  if (lineText.length === 0)
    return around && bounds.end < text.length
      ? { ...lineRange(text, bounds.start, 2), linewise: true }
      : null
  const segments = graphemeSegments(text).filter(
    (segment) => segment.segment !== "\n",
  )
  if (segments.length === 0 && count === 1) return { start: 0, end: 0 }
  let index = segments.findIndex((segment) => segment.index >= offset)
  if (index < 0) return null
  const kind = (value: string) => {
    if (/\s/u.test(value)) return "space"
    return /[\p{L}\p{N}_]/u.test(value) ? "word" : "punctuation"
  }
  const initial = kind(segments[index]!.segment)
  const adjacent = (left: number, right: number) =>
    segments[left]!.index + segments[left]!.segment.length ===
    segments[right]!.index
  const advanceRun = (runStart: number) => {
    const runKind = kind(segments[runStart]!.segment)
    let runEnd = runStart + 1
    while (
      runEnd < segments.length &&
      adjacent(runEnd - 1, runEnd) &&
      kind(segments[runEnd]!.segment) === runKind
    )
      runEnd++
    return runEnd
  }
  let start = index
  while (
    start > 0 &&
    adjacent(start - 1, start) &&
    kind(segments[start - 1]!.segment) === initial
  )
    start--
  let end = index + 1
  while (
    end < segments.length &&
    adjacent(end - 1, end) &&
    kind(segments[end]!.segment) === initial
  )
    end++
  if (!around) {
    for (let object = 1; object < count; object++) {
      if (end >= segments.length) return null
      end = advanceRun(end)
    }
    return withLinewiseIntent(text, {
      start: segments[start]!.index,
      end: segments[end - 1]!.index + segments[end - 1]!.segment.length,
    })
  }
  const objectCount = count + (around && initial === "space" ? 1 : 0)
  for (let object = 1; object < objectCount; object++) {
    while (
      end < segments.length &&
      adjacent(end - 1, end) &&
      kind(segments[end]!.segment) === "space"
    )
      end++
    if (end >= segments.length) return null
    end = advanceRun(end)
  }
  if (around && initial !== "space") {
    const coreEnd = end
    while (
      end < segments.length &&
      adjacent(end - 1, end) &&
      kind(segments[end]!.segment) === "space"
    )
      end++
    if (end === coreEnd) {
      let whitespaceStart = start
      while (
        whitespaceStart > 0 &&
        adjacent(whitespaceStart - 1, whitespaceStart) &&
        kind(segments[whitespaceStart - 1]!.segment) === "space"
      )
        whitespaceStart--
      if (segments[whitespaceStart]!.index > bounds.start)
        start = whitespaceStart
    }
  }
  const range: TextRange = {
    start: segments[start]!.index,
    end: segments[end - 1]!.index + segments[end - 1]!.segment.length,
  }
  return withLinewiseIntent(text, range)
}

function delimiterObjectRange(
  text: string,
  offset: number,
  open: string,
  close: string,
  around: boolean,
  count: number,
): TextRange | null {
  const pairs: Array<{ start: number; end: number }> = []
  const stack: number[] = []
  const escaped = (offset: number) => {
    let slashes = 0
    for (let index = offset - 1; text[index] === "\\"; index--) slashes++
    return slashes % 2 === 1
  }
  for (const segment of graphemeSegments(text)) {
    if (escaped(segment.index)) continue
    if (segment.segment === open) stack.push(segment.index)
    if (segment.segment === close) {
      const start = stack.pop()
      if (start !== undefined)
        pairs.push({ start, end: segment.index + segment.segment.length })
    }
  }
  const containing = pairs
    .filter((pair) => pair.start <= offset && pair.end > offset)
    .sort((left, right) => left.end - left.start - (right.end - right.start))
  const forward = pairs
    .filter((pair) => pair.start >= offset)
    .sort(
      (left, right) =>
        left.start - right.start ||
        left.end - left.start - (right.end - right.start),
    )
  const pair =
    containing.length > 0
      ? containing[count - 1]
      : count === 1
        ? forward[0]
        : undefined
  if (!pair) return null
  return around
    ? pair
    : { start: pair.start + open.length, end: pair.end - close.length }
}

function quoteObjectRange(
  text: string,
  offset: number,
  quote: string,
  around: boolean,
  count: number,
): TextRange | null {
  const bounds = lineBounds(text, offset)
  const quotes = graphemeSegments(text)
    .filter(
      (segment) =>
        segment.index >= bounds.start &&
        segment.index < bounds.end &&
        segment.segment === quote &&
        (() => {
          let slashes = 0
          for (let index = segment.index - 1; text[index] === "\\"; index--)
            slashes++
          return slashes % 2 === 0
        })(),
    )
    .map((segment) => segment.index)
  if (quotes.length < 2) return null
  const exact = quotes.indexOf(offset)
  let left: number
  if (exact >= 0) left = exact % 2 === 0 ? exact : exact - 1
  else {
    const right = quotes.findIndex((position) => position > offset)
    if (right < 0) return null
    left = right <= 0 ? 0 : right - 1
  }
  const start = quotes[left]
  const end = quotes[left + 1]
  if (start === undefined || end === undefined) return null
  if (!around && count === 1) return { start: start + quote.length, end }
  if (!around) return { start, end: end + quote.length }
  let rangeStart = start
  let rangeEnd = end + quote.length
  while (rangeEnd < bounds.end && /[ \t]/u.test(text[rangeEnd] ?? ""))
    rangeEnd++
  if (rangeEnd === end + quote.length)
    while (
      rangeStart > bounds.start &&
      /[ \t]/u.test(text[rangeStart - 1] ?? "")
    )
      rangeStart--
  return { start: rangeStart, end: rangeEnd }
}

function textObjectRange(
  text: string,
  offset: number,
  object: TextObject,
  around: boolean,
  count: number,
) {
  if (object === "word") return wordObjectRange(text, offset, around, count)
  if (object === "paren")
    return delimiterObjectRange(text, offset, "(", ")", around, count)
  if (object === "brace")
    return delimiterObjectRange(text, offset, "{", "}", around, count)
  if (object === "bracket")
    return delimiterObjectRange(text, offset, "[", "]", around, count)
  return quoteObjectRange(
    text,
    offset,
    object === "double-quote" ? '"' : "'",
    around,
    count,
  )
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
  percentage = false,
) {
  if (percentage && count > 100) return
  for (let index = 0; index < count; index++) {
    if (key === "h") editor.moveCursorLeft({ select })
    if (key === "j") editor.moveCursorDown({ select })
    if (key === "k") editor.moveCursorUp({ select })
    if (key === "l") editor.moveCursorRight({ select })
    if (key === "w") editor.moveWordForward({ select })
    if (key === "b") editor.moveWordBackward({ select })
  }
  if (key === "W" || key === "B" || key === "E") {
    const target = bigWordDestination(
      editor.plainText,
      editor.cursorOffset,
      count,
      key,
    )
    if (select) selectTo(editor, target)
    else editor.cursorOffset = target
  }
  if (key === "0" || key === "^") {
    const bounds = lineBounds(editor.plainText, editor.cursorOffset)
    const target =
      key === "^" ? firstNonblank(editor.plainText, bounds.start) : bounds.start
    if (select) selectTo(editor, target)
    editor.cursorOffset = target
  }
  if (key === "$") {
    const row = Math.min(
      rowAt(editor.plainText, editor.cursorOffset) + count - 1,
      editor.lineCount - 1,
    )
    const bounds = lineBounds(editor.plainText, rowStart(editor.plainText, row))
    const target = retreatGraphemes(
      editor.plainText,
      bounds.end,
      1,
      bounds.start,
    )
    if (select) selectTo(editor, target)
    editor.cursorOffset = target
  }
  if (key === "G" || key === "gg") {
    const target = firstNonblank(
      editor.plainText,
      rowStart(editor.plainText, destinationRow(editor, key, count)),
    )
    if (select) selectTo(editor, target)
    editor.cursorOffset = target
  }
  if (key === "e") {
    const target = endOfWord(editor.plainText, editor.cursorOffset, count)
    if (select) selectTo(editor, target)
    editor.cursorOffset = target
  }
  if (key === "%") {
    const target = percentage
      ? firstNonblank(
          editor.plainText,
          rowStart(
            editor.plainText,
            Math.min(
              editor.lineCount - 1,
              Math.max(0, Math.ceil((count * editor.lineCount) / 100) - 1),
            ),
          ),
        )
      : matchingDelimiter(editor.plainText, editor.cursorOffset)
    if (target !== null) {
      if (select) selectTo(editor, target)
      else editor.cursorOffset = target
    }
  }
}

function applyCharacterRange(
  editor: VimEditor,
  operator: Operator,
  range: TextRange,
  setRegister: (text: string, linewise?: boolean) => void,
  writeClipboard: (text: string) => void,
) {
  const selected = editor.plainText.slice(range.start, range.end)
  if (!selected) {
    if (operator === "change") {
      editor.cursorOffset = range.start
      return true
    }
    return false
  }
  setRegister(selected)
  editor.clearSelection()
  if (operator === "yank") {
    writeClipboard(selected)
    editor.cursorOffset = range.start
  } else replaceRange(editor, range.start, range.end, "", range.start)
  return true
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
  selectedLineCount?: number,
) {
  const selected = editor.plainText.slice(range.start, range.end)
  const missingLineTerminators =
    selectedLineCount === undefined
      ? 0
      : Math.max(0, selectedLineCount - (selected.match(/\n/g)?.length ?? 0))
  const registerText = `${selected}${"\n".repeat(missingLineTerminators)}`
  const value = linewiseValue(registerText)
  setRegister(registerText, true)
  if (operator === "yank") {
    writeClipboard(`${value}\n`)
    editor.cursorOffset = yankCursor
    return
  }
  if (operator === "change") {
    const end =
      selected.endsWith("\n") && missingLineTerminators === 0
        ? range.end - 1
        : range.end
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
  percentage = false,
) {
  if (
    key === "j" ||
    key === "k" ||
    key === "G" ||
    key === "gg" ||
    (key === "%" && percentage)
  ) {
    if (key === "%" && count > 100) return false
    const currentStart = lineBounds(editor.plainText, editor.cursorOffset).start
    const column = editor.cursorOffset - currentStart
    const targetRow =
      key === "%"
        ? Math.min(
            editor.lineCount - 1,
            Math.max(0, Math.ceil((count * editor.lineCount) / 100) - 1),
          )
        : destinationRow(editor, key, count)
    const currentRow = rowAt(editor.plainText, editor.cursorOffset)
    if ((key === "j" || key === "k") && targetRow === currentRow) return false
    const range =
      key === "%"
        ? lineRange(
            editor.plainText,
            rowStart(editor.plainText, Math.min(currentRow, targetRow)),
            Math.abs(targetRow - currentRow) + 1,
          )
        : linewiseMotionRange(editor, key, count)
    applyLineRange(
      editor,
      operator,
      range,
      setRegister,
      writeClipboard,
      cursorAtColumn(editor.plainText, range.start, column),
    )
    return true
  }
  if (key === "W" || key === "B" || key === "E") {
    const original = editor.cursorOffset
    const target = bigWordDestination(editor.plainText, original, count, key)
    if (key === "B" && target === original) return false
    const reachedEnd =
      key === "W" &&
      target === lastGraphemeStart(editor.plainText) &&
      !/\s/u.test(editor.plainText[target] ?? "")
    const changeWord = operator === "change" && key === "W"
    const changeTarget = changeWord
      ? bigWordDestination(editor.plainText, original, count, "E")
      : target
    if (
      key === "W" &&
      target > original &&
      target <= firstNonblank(editor.plainText, target)
    ) {
      const adjustedEnd = lineBounds(editor.plainText, target - 1).end
      if (
        rowAt(editor.plainText, adjustedEnd) >
          rowAt(editor.plainText, original) &&
        original <= firstNonblank(editor.plainText, original)
      ) {
        applyLineRange(
          editor,
          operator,
          { start: lineBounds(editor.plainText, original).start, end: target },
          setRegister,
          writeClipboard,
        )
        return true
      }
      const succeeded = applyCharacterRange(
        editor,
        operator,
        { start: original, end: adjustedEnd },
        setRegister,
        writeClipboard,
      )
      if (succeeded && operator === "yank") editor.cursorOffset = original
      return succeeded
    }
    const range = {
      start: Math.min(original, changeTarget),
      end:
        key === "E" || changeWord || reachedEnd
          ? nextGraphemeStart(
              editor.plainText,
              Math.max(original, changeTarget),
            )
          : Math.max(original, changeTarget),
    }
    const succeeded = applyCharacterRange(
      editor,
      operator,
      range,
      setRegister,
      writeClipboard,
    )
    if (succeeded && operator === "yank" && target > original)
      editor.cursorOffset = original
    return succeeded
  }
  const original = editor.cursorOffset
  const originalBounds = lineBounds(editor.plainText, original)
  if (key === "$" && originalBounds.start === originalBounds.end)
    return operator === "change"
  editor.clearSelection()
  const changeWord =
    operator === "change" &&
    key === "w" &&
    !/\s/u.test(editor.plainText[editor.cursorOffset] ?? "")
  if (changeWord) {
    const target = endOfWord(editor.plainText, editor.cursorOffset, count, true)
    setGraphemeInclusiveSelection(editor, original, target)
    editor.cursorOffset = target
  } else move(editor, key, count, true, percentage)
  if (
    !changeWord &&
    editor.cursorOffset === original &&
    key !== "$" &&
    key !== "e"
  ) {
    editor.clearSelection()
    return false
  }
  const selection = editor.getSelection()
  if (!selection) return false
  const selected = editor.plainText.slice(selection.start, selection.end)
  if (selected) setRegister(selected)
  editor.clearSelection()
  if (operator === "yank") {
    if (selected) writeClipboard(selected)
    editor.cursorOffset = original
  } else {
    replaceRange(editor, selection.start, selection.end, "", selection.start)
    if (operator === "delete" && key === "$") {
      const bounds = lineBounds(editor.plainText, editor.cursorOffset)
      if (bounds.end > bounds.start && editor.cursorOffset >= bounds.end)
        editor.cursorOffset = retreatGraphemes(
          editor.plainText,
          bounds.end,
          1,
          bounds.start,
        )
    }
  }
  return true
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

function indentRange(
  editor: VimEditor,
  range: { start: number; end: number },
  direction: "left" | "right",
  count: number,
) {
  const start = lineBounds(editor.plainText, range.start).start
  const last = lineBounds(
    editor.plainText,
    Math.max(start, range.end - 1),
  ).start
  let end = lineBounds(editor.plainText, last).end
  if (end < editor.plainText.length) end++
  const selected = editor.plainText.slice(start, end)
  const shifted = selected
    .split("\n")
    .map((line, index, lines) => {
      if (index === lines.length - 1 && line === "") return line
      if (direction === "right") return "\t".repeat(count) + line
      let remaining = count * 8
      let offset = 0
      while (remaining > 0 && offset < line.length) {
        if (line[offset] === "\t") {
          offset++
          remaining -= 8
        } else if (line[offset] === " ") {
          offset++
          remaining--
        } else break
      }
      return line.slice(offset)
    })
    .join("\n")
  if (shifted === selected) return false
  replaceRange(
    editor,
    start,
    end,
    shifted,
    direction === "right" ? start : start + firstNonblank(shifted, 0),
  )
  return true
}

function toggleCase(text: string) {
  return graphemeSegments(text)
    .map((segment) => {
      if (segment.segment === "\n") return "\n"
      const lower =
        segment.segment === "İ" ? "i" : segment.segment.toLowerCase()
      const mapped =
        segment.segment === lower
          ? segment.segment === "ß"
            ? "ẞ"
            : segment.segment.toUpperCase()
          : lower
      return graphemeSegments(mapped).length === 1 ? mapped : segment.segment
    })
    .join("")
}

function hostEdit(baseline: Snapshot, exit: Snapshot): TextEdit {
  const baselineStart = baseline.selection?.start ?? baseline.cursor
  const baselineEnd = baseline.selection?.end ?? baseline.cursor
  const exitAnchor = exit.selection?.start ?? exit.cursor
  let prefix = 0
  while (
    prefix < baselineStart &&
    prefix < exitAnchor &&
    baseline.text[prefix] === exit.text[prefix]
  )
    prefix++
  let suffix = 0
  while (
    suffix < baseline.text.length - baselineEnd &&
    suffix < exit.text.length - exitAnchor &&
    baseline.text[baseline.text.length - 1 - suffix] ===
      exit.text[exit.text.length - 1 - suffix]
  )
    suffix++
  return {
    startDelta: prefix - baseline.cursor,
    deleteCount: baseline.text.length - prefix - suffix,
    text: exit.text.slice(prefix, exit.text.length - suffix),
    cursorDelta: exit.cursor - prefix,
  }
}

function repeatableAction(action: VimAction) {
  if (action.type === "delete-char" || action.type === "paste") return true
  if (action.type === "replace" || action.type === "join-lines") return true
  if (action.type === "operator-motion" || action.type === "operator-line")
    return action.operator !== "yank"
  if (action.type === "find" || action.type === "text-object")
    return action.operator !== undefined && action.operator !== "yank"
  if (action.type === "visual-operator") return action.operator !== "yank"
  if (
    action.type === "visual-paste" ||
    action.type === "visual-replace" ||
    action.type === "visual-join" ||
    action.type === "visual-case" ||
    action.type === "visual-indent"
  )
    return true
  return false
}

function withRepeatCount(action: VimAction, count?: number): VimAction {
  if (!count || !("count" in action)) return { ...action }
  return { ...action, count } as VimAction
}

function leaveInsertAfterRepeat(editor: VimEditor, effects: ActionEffects) {
  effects.transitionRuntime((next) => {
    next.mode = "normal"
    next.oneShotNormal = false
    next.visual = null
  })
  const bounds = lineBounds(editor.plainText, editor.cursorOffset)
  if (editor.cursorOffset > bounds.start)
    editor.cursorOffset = retreatGraphemes(
      editor.plainText,
      editor.cursorOffset,
      1,
      bounds.start,
    )
}

export function runActions(
  editor: VimEditor,
  actions: VimAction[],
  register: Register,
  runtime: VimState,
  history: VimHistory,
  effects: ActionEffects,
) {
  const before = snapshotOf(editor)
  const repeat = actions.find((action) => action.type === "repeat")
  if (repeat?.type === "repeat") {
    const descriptor = history.lastChange
    if (!descriptor) return
    const repeatedActions = descriptor.actions.map((action, index) =>
      withRepeatCount(action, index === 0 ? repeat.count : undefined),
    )
    const isolated = createVimHistory(editor.plainText)
    runActions(editor, repeatedActions, register, runtime, isolated, effects)
    if (descriptor.edit && isolated.changeSession) {
      const enterAction = repeatedActions[0]
      const editCount = enterAction?.type === "enter" ? enterAction.count : 1
      for (let index = 0; index < editCount; index++) {
        if (index > 0 && enterAction?.type === "enter") {
          if (enterAction.key === "o" || enterAction.key === "O")
            enter(editor, enterAction.key)
        }
        const start = Math.max(
          0,
          Math.min(
            editor.plainText.length,
            editor.cursorOffset + descriptor.edit.startDelta,
          ),
        )
        replaceRange(
          editor,
          start,
          Math.min(
            editor.plainText.length,
            start + descriptor.edit.deleteCount,
          ),
          descriptor.edit.text,
          start + descriptor.edit.cursorDelta,
        )
      }
      leaveInsertAfterRepeat(editor, effects)
    }
    if (
      editor.plainText !== before.text ||
      isolated.undo.length > 0 ||
      isolated.changeSession !== null
    ) {
      pushSnapshot(history.undo, before)
      history.redo.length = 0
    }
    history.currentText = editor.plainText
    return
  }
  const exitingSession =
    history.changeSession &&
    actions.some(
      (action) =>
        action.type === "mode" && action.mode === "normal" && !action.oneShot,
    )
  if (exitingSession) finalizeInsertSession(editor, history)
  let historyAction = false
  let successfulChange = false
  let semanticVisualAction: VimAction | null = null
  let semanticUndo: Snapshot | null = null
  const setRegister = (text: string, linewise = false) => {
    register.value = linewise ? linewiseValue(text) : text
    register.linewise = linewise
  }
  for (const action of actions) {
    if (action.type === "motion") {
      const visual = runtime.mode === "visual" ? runtime.visual : null
      if (visual && visual.anchor !== null && visual.active !== null) {
        const anchor = visual.anchor
        editor.clearSelection()
        editor.cursorOffset = visual.active
        move(editor, action.key, action.count, false, action.percentage)
        const active = editor.cursorOffset
        renderVisualEndpoints(editor, visual.kind, anchor, active)
        updateVisualEndpoints(effects, anchor, active)
      } else
        move(
          editor,
          action.key,
          action.count,
          editor.hasSelection(),
          action.percentage,
        )
    }
    if (action.type === "operator-motion") {
      const succeeded = applyOperatorMotion(
        editor,
        action.operator,
        action.key,
        action.count,
        setRegister,
        effects.writeClipboard,
        action.percentage,
      )
      if (succeeded && action.operator !== "yank") successfulChange = true
      if (succeeded && action.operator === "change") {
        effects.transitionRuntime((next) => {
          next.mode = "insert"
          next.oneShotNormal = false
          next.visual = null
        })
        if (!history.changeSession)
          history.changeSession = {
            before,
            actions: [{ ...action }],
            baseline: snapshotOf(editor),
          }
      }
    }
    if (action.type === "find") {
      const original = editor.cursorOffset
      const target = findDestination(
        editor.plainText,
        original,
        action.find,
        action.count,
        action.repeat ?? false,
      )
      if (target !== null) {
        if (action.operator) {
          const start = Math.min(original, target)
          const end =
            target < original
              ? original
              : nextGraphemeStart(editor.plainText, target)
          if (
            applyCharacterRange(
              editor,
              action.operator,
              { start, end },
              setRegister,
              effects.writeClipboard,
            ) &&
            action.operator === "change"
          ) {
            successfulChange = true
            effects.transitionRuntime((next) => {
              next.mode = "insert"
              next.oneShotNormal = false
              next.visual = null
            })
            if (!history.changeSession)
              history.changeSession = {
                before,
                actions: [{ ...action }],
                baseline: snapshotOf(editor),
              }
          }
        } else if (
          runtime.mode === "visual" &&
          runtime.visual &&
          runtime.visual.anchor !== null
        ) {
          const anchor = runtime.visual.anchor
          renderVisualEndpoints(editor, runtime.visual.kind, anchor, target)
          updateVisualEndpoints(effects, anchor, target)
        } else if (editor.hasSelection()) selectTo(editor, target)
        else editor.cursorOffset = target
      }
    }
    if (action.type === "text-object") {
      const range = textObjectRange(
        editor.plainText,
        editor.cursorOffset,
        action.object,
        action.around,
        action.count,
      )
      if (range && action.operator) {
        const applied = range.linewise
          ? (applyLineRange(
              editor,
              action.operator,
              range,
              setRegister,
              effects.writeClipboard,
            ),
            true)
          : applyCharacterRange(
              editor,
              action.operator,
              range,
              setRegister,
              effects.writeClipboard,
            )
        if (applied && action.operator === "change") {
          successfulChange = true
          effects.transitionRuntime((next) => {
            next.mode = "insert"
            next.oneShotNormal = false
            next.visual = null
          })
          if (!history.changeSession)
            history.changeSession = {
              before,
              actions: [{ ...action }],
              baseline: snapshotOf(editor),
            }
        }
      } else if (range) {
        const end = retreatGraphemes(
          editor.plainText,
          range.end,
          1,
          range.start,
        )
        const visual = runtime.mode === "visual" ? runtime.visual : null
        const reversed =
          action.object === "word" &&
          visual !== null &&
          visual.anchor !== null &&
          visual.active !== null &&
          visual.active < visual.anchor
        const anchor =
          action.object === "word" && visual?.anchor != null
            ? visual.anchor
            : range.start
        const active = reversed
          ? retreatGraphemes(editor.plainText, range.start, 1)
          : end
        renderVisualEndpoints(editor, "character", anchor, active)
        effects.transitionRuntime((next) => {
          if (!next.visual) return
          next.visual.kind = "character"
          next.visual.anchor = anchor
          next.visual.active = active
        })
      } else if (action.object === "word") {
        editor.cursorOffset = lastGraphemeStart(editor.plainText)
      }
    }
    if (action.type === "operator-line") {
      applyLineRange(
        editor,
        action.operator,
        lineRange(editor.plainText, editor.cursorOffset, action.count),
        setRegister,
        effects.writeClipboard,
        editor.cursorOffset,
      )
      if (action.operator !== "yank") successfulChange = true
      if (action.operator === "change" && !history.changeSession)
        history.changeSession = {
          before,
          actions: [{ ...action }],
          baseline: snapshotOf(editor),
        }
    }
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
        successfulChange = true
        setRegister(deleted)
        replaceRange(editor, start, end, "", start)
      }
    }
    if (
      action.type === "paste" &&
      (register.value !== "" || register.linewise)
    ) {
      successfulChange = true
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
      if (count === action.count) {
        successfulChange = true
        const replacement =
          action.text === "\n" ? action.text : action.text.repeat(count)
        replaceRange(
          editor,
          editor.cursorOffset,
          end,
          replacement,
          editor.cursorOffset +
            (action.text === "\n"
              ? action.text.length
              : lastGraphemeStart(replacement)),
        )
      }
    }
    if (action.type === "command") effects.dispatch(action.id)
    if (action.type === "join-lines") {
      let text = editor.plainText
      let cursor = editor.cursorOffset
      const joins = action.count === 1 ? 1 : action.count - 1
      for (let index = 0; index < joins; index++) {
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
        successfulChange = true
        editor.replaceText(text)
        editor.cursorOffset = cursor
      }
    }
    if (action.type === "undo") {
      historyAction = true
      trimSnapshots(history.undo)
      const snapshot = history.undo.pop()
      if (snapshot) {
        pushSnapshot(history.redo, snapshotOf(editor))
        editor.setText(snapshot.text)
        editor.cursorOffset = snapshot.cursor
      }
    }
    if (action.type === "redo") {
      historyAction = true
      trimSnapshots(history.redo)
      const snapshot = history.redo.pop()
      if (snapshot) {
        pushSnapshot(history.undo, snapshotOf(editor))
        editor.setText(snapshot.text)
        editor.cursorOffset = snapshot.cursor
      }
    }
    if (action.type === "ex") effects.openEx()
    if (action.type === "enter") {
      enter(editor, action.key)
      if (!history.changeSession)
        history.changeSession = {
          before,
          actions: [{ ...action }],
          baseline: snapshotOf(editor),
        }
    }
    if (action.type === "visual-swap") {
      const visual = runtime.visual
      if (visual && visual.anchor !== null && visual.active !== null) {
        renderVisualEndpoints(editor, visual.kind, visual.active, visual.anchor)
        updateVisualEndpoints(effects, visual.active, visual.anchor)
      }
    }
    if (action.type === "visual-paste") {
      const selection = action.shape
        ? rangeForShape(editor, action.shape)
        : editor.getSelection()
      if (selection) {
        const linewise =
          action.shape?.linewise ?? runtime.visual?.kind === "line"
        const shape = action.shape ?? visualShape(editor, selection, linewise)
        const replaced = editor.plainText.slice(selection.start, selection.end)
        if (!action.shape)
          semanticUndo = { ...before, cursor: selection.start, selection: null }
        const source = { ...register }
        let replacement = source.linewise
          ? `${Array.from({ length: action.count }, () => source.value).join("\n")}\n`
          : source.value.repeat(action.count)
        let start = selection.start
        let end = selection.end
        if (linewise) {
          start = lineBounds(editor.plainText, start).start
          end = lineRange(
            editor.plainText,
            lineBounds(editor.plainText, Math.max(start, end - 1)).start,
            1,
          ).end
          if (!source.linewise && end < editor.plainText.length)
            replacement += "\n"
        }
        const atFinalLine = end === editor.plainText.length
        let inserted =
          source.linewise && atFinalLine
            ? `${start > 0 && editor.plainText[start - 1] !== "\n" ? "\n" : ""}${replacement.slice(0, -1)}`
            : replacement
        let firstInserted = start
        if (source.linewise && !linewise) {
          inserted = `\n${replacement}`
          firstInserted++
        }
        editor.clearSelection()
        replaceRange(editor, start, end, inserted, start)
        editor.cursorOffset = source.linewise
          ? firstNonblank(editor.plainText, firstInserted)
          : start + lastGraphemeStart(inserted)
        if (!action.preserveRegister) setRegister(replaced, linewise)
        successfulChange = true
        leaveVisual(effects)
        semanticVisualAction = {
          type: "visual-operator",
          operator: "delete",
          linewise: shape.linewise,
          shape,
          preserveRegister: action.preserveRegister,
        }
      }
    }
    if (action.type === "visual-replace" || action.type === "visual-case") {
      const selection = action.shape
        ? rangeForShape(editor, action.shape)
        : editor.getSelection()
      if (selection) {
        const linewise =
          action.shape?.linewise ?? runtime.visual?.kind === "line"
        const shape = action.shape ?? visualShape(editor, selection, linewise)
        const selected = editor.plainText.slice(selection.start, selection.end)
        if (selected) {
          if (!action.shape)
            semanticUndo = {
              ...before,
              cursor: selection.start,
              selection: null,
            }
          const replacement =
            action.type === "visual-case"
              ? toggleCase(selected)
              : graphemeSegments(selected)
                  .map((segment) =>
                    segment.segment === "\n" ? "\n" : action.text,
                  )
                  .join("")
          editor.clearSelection()
          replaceRange(
            editor,
            selection.start,
            selection.end,
            replacement,
            selection.start,
          )
          successfulChange = true
          leaveVisual(effects)
          semanticVisualAction = { ...action, shape }
        }
      }
    }
    if (action.type === "visual-indent") {
      const selection = action.shape
        ? rangeForShape(editor, action.shape)
        : editor.getSelection()
      if (selection) {
        const shape = action.shape ?? visualShape(editor, selection, true)
        if (indentRange(editor, selection, action.direction, action.count)) {
          if (!action.shape)
            semanticUndo = {
              ...before,
              cursor: selection.start,
              selection: null,
            }
          successfulChange = true
          leaveVisual(effects)
          semanticVisualAction = { ...action, shape }
        } else {
          if (runtime.visual?.kind === "line")
            editor.cursorOffset = Math.min(
              runtime.visual.anchor ?? selection.start,
              runtime.visual.active ?? selection.start,
            )
          editor.clearSelection()
          leaveVisual(effects)
        }
      }
    }
    if (action.type === "visual-join") {
      const selection = action.shape
        ? rangeForShape(editor, action.shape)
        : editor.getSelection()
      if (selection) {
        const shape = action.shape ?? visualShape(editor, selection, true)
        const start = lineBounds(editor.plainText, selection.start).start
        let text = editor.plainText
        let cursor = start
        const joins = shape.lines === 1 ? 1 : shape.lines - 1
        for (let index = 0; index < joins; index++) {
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
          if (!action.shape)
            semanticUndo = {
              ...before,
              cursor: selection.start,
              selection: null,
            }
          editor.clearSelection()
          editor.replaceText(text)
          editor.cursorOffset = cursor
          successfulChange = true
          leaveVisual(effects)
          semanticVisualAction = { ...action, shape }
        } else {
          editor.clearSelection()
          editor.cursorOffset = selection.start
          leaveVisual(effects)
        }
      }
    }
    if (action.type === "visual-operator") {
      let selection = action.shape
        ? rangeForShape(editor, action.shape)
        : editor.getSelection()
      if (selection) {
        const preservedRegister = action.preserveRegister
          ? { ...register }
          : null
        const measuredShape =
          action.shape ?? visualShape(editor, selection, action.linewise)
        const shape =
          !action.shape &&
          action.linewise &&
          runtime.visual?.anchor != null &&
          runtime.visual.active != null
            ? {
                ...measuredShape,
                lines:
                  Math.abs(
                    rowAt(editor.plainText, runtime.visual.active) -
                      rowAt(editor.plainText, runtime.visual.anchor),
                  ) + 1,
              }
            : measuredShape
        const undoCursor = action.linewise
          ? shape.lines === 1
            ? lineBounds(editor.plainText, selection.start).start
            : (runtime.visual?.anchor ?? selection.start) >
                (runtime.visual?.active ?? selection.start)
              ? (runtime.visual?.anchor ?? selection.start)
              : firstNonblank(
                  editor.plainText,
                  runtime.visual?.active ?? selection.end,
                )
          : selection.start
        if (action.linewise)
          selection = lineRange(editor.plainText, selection.start, shape.lines)
        if (!action.shape && action.operator !== "yank")
          semanticUndo = {
            ...before,
            cursor: undoCursor,
            selection: null,
          }
        if (action.operator === "change" && !history.changeSession)
          history.changeSession = {
            before: {
              ...before,
              cursor: undoCursor,
            },
            actions: [{ ...action, shape }],
            baseline: before,
          }
        if (action.linewise) {
          editor.clearSelection()
          applyLineRange(
            editor,
            action.operator,
            selection,
            setRegister,
            effects.writeClipboard,
            undefined,
            Math.min(
              shape.lines,
              editor.lineCount - rowAt(editor.plainText, selection.start),
            ),
          )
          if (action.operator !== "yank") successfulChange = true
          if (action.operator === "change") {
            history.changeSession!.baseline = snapshotOf(editor)
            effects.transitionRuntime((next) => {
              next.mode = "insert"
              next.oneShotNormal = false
              next.visual = null
            })
          } else leaveVisual(effects)
          if (action.operator === "yank") editor.cursorOffset = selection.start
          if (action.operator !== "yank")
            semanticVisualAction = { ...action, shape }
          if (preservedRegister) Object.assign(register, preservedRegister)
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
        if (action.operator !== "yank") successfulChange = true
        if (action.operator === "change") {
          history.changeSession!.baseline = snapshotOf(editor)
          effects.transitionRuntime((next) => {
            next.mode = "insert"
            next.oneShotNormal = false
            next.visual = null
          })
        } else leaveVisual(effects)
        if (action.operator !== "yank")
          semanticVisualAction = { ...action, shape }
        if (preservedRegister) Object.assign(register, preservedRegister)
      }
    }
    if (action.type === "mode") {
      if (action.mode === "visual") {
        const anchor = editor.cursorOffset
        effects.transitionRuntime((next) => {
          if (!next.visual) return
          next.visual.anchor = anchor
          next.visual.active = anchor
        })
        if (action.linewise) {
          const range = lineRange(editor.plainText, editor.cursorOffset, 1)
          editor.setSelection(range.start, range.end)
        } else
          setGraphemeInclusiveSelection(
            editor,
            editor.cursorOffset,
            editor.cursorOffset,
          )
      } else if (editor.hasSelection()) editor.clearSelection()
      else if (action.mode === "normal" && !action.oneShot)
        editor.moveCursorLeft()
    }
  }
  if (runtime.mode === "normal" && !editor.hasSelection()) {
    const bounds = lineBounds(editor.plainText, editor.cursorOffset)
    if (editor.cursorOffset === bounds.end && bounds.start < bounds.end)
      editor.cursorOffset = retreatGraphemes(
        editor.plainText,
        bounds.end,
        1,
        bounds.start,
      )
  }
  if (
    !historyAction &&
    !history.changeSession &&
    (editor.plainText !== before.text || successfulChange)
  ) {
    pushSnapshot(history.undo, semanticUndo ?? before)
    history.redo.length = 0
    const action = semanticVisualAction ?? actions.find(repeatableAction)
    if (action) history.lastChange = { actions: [{ ...action }] }
  }
  history.currentText = editor.plainText
}
