/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import type { EditBufferRenderable, TextRenderable } from "@opentui/core"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { writeClipboard } from "./clipboard.ts"
import { openExDialog } from "./ex-command.ts"
import {
  beginInsertSession,
  createVimHistory,
  finalizeInsertSession,
  insertHostText,
  type Register,
  runActions,
  syncVisualState,
  syncVimHistory,
  type VimHistory,
} from "./editor-actions.ts"
import {
  createVimState,
  hasPendingInput,
  transition,
  type VimAction,
  type VimMode,
  type VimState,
} from "./engine.ts"

type Context = Plugin.Context
type RuntimeState = VimState
type Settings = { enabled: boolean }
type SetRuntime = (mutation: (draft: RuntimeState) => void) => void

const keyBindings: ReadonlyArray<readonly [string, string]> = [
  ..."abcdefghijklmnopqrstuvwxyz".split("").map((key) => [key, key] as const),
  ..."abcdefghijklmnopqrstuvwxyz"
    .split("")
    .map((key) => [`shift+${key}`, key.toUpperCase()] as const),
  ..."0123456789".split("").map((key) => [key, key] as const),
  ["shift+4", "$"],
  ["shift+6", "^"],
  ["shift+1", "!"],
  ["shift+2", "@"],
  ["shift+3", "#"],
  ["shift+5", "%"],
  ["shift+7", "&"],
  ["shift+8", "*"],
  ["shift+9", "("],
  ["shift+0", ")"],
  ["shift+semicolon", ":"],
  ["return", "return"],
  ["escape", "escape"],
  ["backspace", "backspace"],
  ["ctrl+r", "ctrl+r"],
  ["space", "space"],
  ["tab", "tab"],
  ["minus", "-"],
  ["equal", "="],
  ["leftbracket", "["],
  ["rightbracket", "]"],
  ["backslash", "\\"],
  ["semicolon", ";"],
  ["quote", "'"],
  ["comma", ","],
  ["period", "."],
  ["/", "/"],
  ["backquote", "`"],
  ["shift+minus", "_"],
  ["shift+equal", "+"],
  ["shift+leftbracket", "{"],
  ["shift+rightbracket", "}"],
  ["shift+backslash", "|"],
  ["shift+quote", '"'],
  ["shift+comma", "<"],
  ["shift+period", ">"],
  ["shift+slash", "?"],
  ["shift+backquote", "~"],
]

function VimHost(props: {
  context: Context
  runtime: RuntimeState
  setRuntime: SetRuntime
  settings: Settings
  setSettings: (mutation: (draft: Settings) => void) => Promise<void>
  hostMode: "normal" | "shell"
}) {
  const register: Register = { value: "", linewise: false }
  const histories = new WeakMap<EditBufferRenderable, VimHistory>()
  const target = () => props.context.renderer.currentFocusedEditor
  const [mode, setMode] = createSignal(props.runtime.mode)
  const [pending, setPending] = createSignal(hasPendingInput(props.runtime))
  const [enabled, setEnabled] = createSignal(props.settings.enabled)
  const hostPrefixKeys = new Set(
    props.context.keymap
      .active()
      .filter((binding) => binding.continues)
      .map((binding) => binding.key.toLowerCase()),
  )
  const printablePrefix = (key: string) => {
    if (key === "space") return " "
    return [...key].length === 1 ? key : undefined
  }
  const active = () => enabled() && props.hostMode === "normal"
  const bindingsActive = () =>
    active() && props.context.keymap.mode.current() === "base"
  const label = () => (active() ? mode().toUpperCase() : "VIM OFF")
  const color = () =>
    mode() === "insert"
      ? props.context.theme.text.feedback.success.default
      : props.context.theme.text.action.primary.default
  let indicator: TextRenderable | undefined
  let activeInsert:
    { editor: EditBufferRenderable; history: VimHistory } | undefined
  const historyFor = (editor: EditBufferRenderable) => {
    let history = histories.get(editor)
    if (!history) {
      history = createVimHistory(editor.plainText)
      histories.set(editor, history)
    }
    return history
  }
  const beginInsertFor = (editor: EditBufferRenderable) => {
    if (activeInsert?.editor !== editor) {
      if (activeInsert && !activeInsert.editor.isDestroyed)
        finalizeInsertSession(activeInsert.editor, activeInsert.history)
      activeInsert = { editor, history: historyFor(editor) }
    }
    beginInsertSession(editor, activeInsert.history)
    return activeInsert.history
  }
  const updateIndicator = () => {
    if (!indicator || indicator.isDestroyed) return
    indicator.content = `-- ${label()} --`
    indicator.fg = color()
  }
  let focusedEditor: EditBufferRenderable | undefined
  const reconcileEditor = (editor: EditBufferRenderable) => {
    const changed = focusedEditor !== editor
    if (
      changed &&
      props.runtime.mode === "visual" &&
      focusedEditor &&
      !focusedEditor.isDestroyed
    )
      focusedEditor.clearSelection()
    focusedEditor = editor
    if (
      syncVisualState(
        editor,
        props.runtime,
        {
          dispatch() {},
          openEx() {},
          writeClipboard() {},
          transitionRuntime: props.setRuntime,
        },
        changed,
      )
    ) {
      setMode(props.runtime.mode)
      setPending(hasPendingInput(props.runtime))
      updateIndicator()
    }
  }

  const handle = (key: string) => {
    const editor = target()
    if (editor && !editor.isDestroyed) reconcileEditor(editor)
    const history =
      editor && !editor.isDestroyed
        ? mode() === "insert"
          ? beginInsertFor(editor)
          : historyFor(editor)
        : undefined
    let actions: VimAction[] = []
    let nextMode = mode()
    props.setRuntime((draft) => {
      actions = transition(draft, key).actions
      nextMode = draft.mode
      setPending(hasPendingInput(draft))
    })
    setMode(nextMode)
    updateIndicator()
    if (!editor || editor.isDestroyed) return
    if (!history) return
    syncVimHistory(history, editor.plainText)
    if (editor.plainText.length === 0) {
      for (const action of actions) {
        if (
          action.type !== "motion" ||
          (action.key !== "j" && action.key !== "k")
        )
          continue
        const id =
          action.key === "k" ? "prompt.history.previous" : "prompt.history.next"
        for (let index = 0; index < action.count; index++)
          queueMicrotask(() => props.context.keymap.dispatch(id))
      }
      actions = actions.filter(
        (action) =>
          action.type !== "motion" ||
          (action.key !== "j" && action.key !== "k"),
      )
    }
    runActions(editor, actions, register, props.runtime, history, {
      dispatch: (id) => queueMicrotask(() => props.context.keymap.dispatch(id)),
      openEx: () => {
        void openExDialog(props.context).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          void props.context.ui.dialog
            .alert({ title: "EX command", message })
            .catch(() => {})
        })
      },
      writeClipboard,
      transitionRuntime: props.setRuntime,
    })
    setMode(props.runtime.mode)
    updateIndicator()
    syncCursor()
  }

  const commands = (scope: string, respectHostPrefixes: boolean) =>
    keyBindings
      .filter(
        ([bind]) =>
          !respectHostPrefixes || !hostPrefixKeys.has(bind.toLowerCase()),
      )
      .map(([bind, key], index) => ({
        id: `vimcode-v2.${scope}.${index}`,
        bind,
        run: () => handle(key),
      }))

  props.context.keymap.layer(() => ({
    mode: "base",
    target,
    priority: 10_000,
    enabled: () => bindingsActive() && mode() === "insert",
    commands: [
      ...[...hostPrefixKeys].flatMap((bind, index) => {
        const text = printablePrefix(bind)
        if (text === undefined) return []
        return [
          {
            id: `vimcode-v2.insert.leader.${index}`,
            bind,
            run: () => {
              const editor = target()
              if (!editor || editor.isDestroyed) return
              insertHostText(editor, beginInsertFor(editor), text)
            },
          },
        ]
      }),
      {
        id: "vimcode-v2.insert.escape",
        bind: "escape",
        run: () => handle("escape"),
      },
      {
        id: "vimcode-v2.insert.ctrl-bracket",
        bind: "ctrl+[",
        run: () => handle("ctrl+["),
      },
      {
        id: "vimcode-v2.insert.ctrl-o",
        bind: "ctrl+o",
        run: () => handle("ctrl+o"),
      },
      {
        id: "vimcode-v2.insert.return",
        bind: "return",
        run: () => handle("return"),
      },
      {
        id: "vimcode-v2.insert.ctrl-return",
        bind: "ctrl+return",
        run: () => handle("ctrl+return"),
      },
    ],
  }))

  props.context.keymap.layer(() => ({
    mode: "base",
    target,
    priority: 10_000,
    enabled: () => bindingsActive() && mode() === "normal" && !pending(),
    commands: commands("normal", true),
  }))

  props.context.keymap.layer(() => ({
    mode: "base",
    target,
    priority: 10_001,
    enabled: () => bindingsActive() && mode() === "normal" && pending(),
    commands: commands("normal.pending", false),
  }))

  props.context.keymap.layer(() => ({
    mode: "base",
    target,
    priority: 10_000,
    enabled: () => bindingsActive() && mode() === "visual" && !pending(),
    commands: commands("visual", true),
  }))

  props.context.keymap.layer(() => ({
    mode: "base",
    target,
    priority: 10_001,
    enabled: () => bindingsActive() && mode() === "visual" && pending(),
    commands: commands("visual.pending", false),
  }))

  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "vimcode-v2.toggle",
        title: "Toggle Vim mode",
        description: "Enable or disable modal editing in the prompt",
        group: "Vim",
        palette: true,
        slash: { name: "vim" },
        run: () => {
          const next = !enabled()
          void props.setSettings((draft) => {
            draft.enabled = next
          })
          setEnabled(next)
          updateIndicator()
          syncCursor()
          props.context.ui.toast.show({
            message: `Vim mode ${next ? "enabled" : "disabled"}`,
            variant: "info",
          })
        },
      },
    ],
  }))

  const originalStyles = new Map<
    EditBufferRenderable,
    EditBufferRenderable["cursorStyle"]
  >()
  const restoreCursors = (except?: EditBufferRenderable) => {
    for (const [editor, style] of originalStyles) {
      if (editor === except) continue
      if (!editor.isDestroyed) editor.cursorStyle = style
      originalStyles.delete(editor)
    }
  }
  const syncCursor = () => {
    const editor = target()
    if (!editor || editor.isDestroyed || !active()) {
      focusedEditor = undefined
      restoreCursors()
      return
    }
    if (!bindingsActive()) {
      restoreCursors()
      return
    }
    reconcileEditor(editor)
    if (mode() === "insert") beginInsertFor(editor)
    restoreCursors(editor)
    if (!originalStyles.has(editor))
      originalStyles.set(editor, { ...editor.cursorStyle })
    editor.cursorStyle = {
      style: mode() !== "insert" ? "block" : "line",
      blinking: true,
    }
  }
  createEffect(syncCursor)
  const cursorTimer = setInterval(syncCursor, 50)
  syncCursor()
  onCleanup(() => {
    clearInterval(cursorTimer)
    restoreCursors()
  })

  return (
    <text
      ref={(node: TextRenderable) => {
        indicator = node
      }}
      fg={color()}
    >
      -- {label()} --
    </text>
  )
}

export default Plugin.define({
  id: "vimcode-v2",
  setup(context) {
    const startMode: VimMode =
      context.options.startMode === "normal" ? "normal" : "insert"
    const [runtime, setRuntime] = context.storage.memory<RuntimeState>(
      "vimcode-v2.runtime.v1",
      {
        initial: createVimState(startMode),
      },
    )
    const [settings, setSettings] = context.storage.store<Settings>(
      "vimcode-v2.settings.v1",
      {
        initial: { enabled: true },
      },
    )
    const unsubscribe = context.ui.slot("prompt.footer.end", (slot) => (
      <VimHost
        context={context}
        runtime={runtime}
        setRuntime={setRuntime}
        settings={settings}
        setSettings={setSettings}
        hostMode={slot.mode}
      />
    ))
    return unsubscribe
  },
})
