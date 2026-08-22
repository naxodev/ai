/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createVimState } from "../engine.ts"
import plugin from "../index.tsx"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

class HostEditor {
  cursorOffset = 0
  cursorStyle = { style: "line" as const, blinking: true }
  isDestroyed = false
  private selection: { start: number; end: number } | null = null

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
    this.selection = { start, end }
  }

  clearSelection() {
    const selected = this.selection !== null
    this.selection = null
    return selected
  }

  moveCursorLeft() {
    this.cursorOffset = Math.max(0, this.cursorOffset - 1)
    return true
  }

  moveCursorRight() {
    this.cursorOffset++
    return true
  }

  moveCursorUp() {
    return true
  }

  moveCursorDown() {
    return true
  }

  moveWordForward() {
    return true
  }

  moveWordBackward() {
    return true
  }

  setText(text: string) {
    this.plainText = text
  }

  replaceText(text: string) {
    this.plainText = text
  }

  insertText(text: string) {
    this.plainText =
      this.plainText.slice(0, this.cursorOffset) +
      text +
      this.plainText.slice(this.cursorOffset)
    this.cursorOffset += text.length
  }

  undo() {
    return true
  }

  redo() {
    return true
  }
}

type DurableSetter = (
  mutation: (draft: { enabled: boolean }) => void,
) => Promise<void>

async function harness(
  options: {
    mode?: "insert" | "normal"
    setDurable?: (
      settings: { enabled: boolean },
      apply: (enabled: boolean) => void,
    ) => DurableSetter
    prompt?: () => Promise<string | undefined>
  } = {},
) {
  const runtime = createVimState(options.mode ?? "insert")
  const editor = new HostEditor("a")
  const session = {
    register: { value: "", linewise: false },
    histories: new WeakMap(),
  }
  const memory = { sessions: new Map([["shared", session]]) }
  const [settings, setSettings] = createStore({ enabled: true })
  const setDurable = options.setDurable
    ? options.setDurable(settings, (enabled) => setSettings("enabled", enabled))
    : async (mutation: (draft: { enabled: boolean }) => void) => {
        const draft = { enabled: settings.enabled }
        mutation(draft)
        setSettings("enabled", draft.enabled)
      }
  const layers: Array<() => any> = []
  const toasts: Array<{ message: string; variant?: string }> = []
  const dispatched: Array<[string, string | undefined]> = []
  const alerts: Array<{ title: string; message: string }> = []
  let slot: { render: (props: { mode: "normal" | "shell" }) => any } | undefined
  const context = {
    options: { clipboard: "none" },
    renderer: { currentFocusedEditor: editor },
    theme: {
      text: {
        feedback: { success: { default: "#00ff00" } },
        action: { primary: { default: "#ffffff" } },
      },
    },
    keymap: {
      active: () => [],
      layer: (layer: () => any) => layers.push(layer),
      mode: { current: () => "base" },
      commands: () => [
        { id: "session.review", slash: { name: "review" }, run() {} },
      ],
      dispatch: (id: string, input?: string) => dispatched.push([id, input]),
    },
    storage: {
      memory(key: string) {
        return key.includes("runtime")
          ? [
              runtime,
              (mutation: (draft: typeof runtime) => void) => mutation(runtime),
            ]
          : [
              memory,
              (mutation: (draft: typeof memory) => void) => mutation(memory),
            ]
      },
      store: () => [settings, setDurable],
    },
    ui: {
      slot(claim: typeof slot) {
        slot = claim
        return () => {}
      },
      toast: { show: (toast: (typeof toasts)[number]) => toasts.push(toast) },
      dialog: {
        prompt: options.prompt ?? (async () => undefined),
        async alert(alert: (typeof alerts)[number]) {
          alerts.push(alert)
        },
      },
    },
  }
  const cleanup = await plugin.setup(context as any)
  if (!slot) throw new Error("plugin did not register its prompt slot")
  const [hostMode, setHostMode] = createSignal<"normal" | "shell">("normal")
  const rendered = await testRender(() =>
    slot!.render({
      get mode() {
        return hostMode()
      },
    }),
  )
  await rendered.flush()

  return {
    alerts,
    cleanup,
    dispatched,
    editor,
    layers,
    rendered,
    session,
    setHostMode,
    setSettings,
    settings,
    toasts,
  }
}

function command(layers: Array<() => any>, id: string) {
  return layers
    .flatMap((layer) => layer().commands ?? [])
    .find((candidate) => candidate.id === id)
}

test("live durable settings control bindings and persistence gates success", async () => {
  const persisted = deferred<void>()
  const host = await harness({
    setDurable: (settings, apply) => async (mutation) => {
      const draft = { enabled: settings.enabled }
      mutation(draft)
      await persisted.promise
      apply(draft.enabled)
    },
  })

  try {
    expect(host.layers[0]?.().enabled()).toBe(true)
    host.setSettings("enabled", false)
    expect(host.layers[0]?.().enabled()).toBe(false)
    host.setSettings("enabled", true)

    host.editor.plainText = "xa"
    host.editor.cursorOffset = 1
    const pending = command(host.layers, "vimcode-v2.toggle")!.run()
    const history = host.session.histories.get(host.editor as any)!
    expect(history.changeSession).not.toBeNull()
    expect(history.undo).toHaveLength(0)
    expect(host.toasts).toEqual([])

    persisted.resolve()
    await pending
    expect(host.settings.enabled).toBe(false)
    expect(history.changeSession).toBeNull()
    expect(history.undo).toHaveLength(1)
    expect(host.toasts).toEqual([
      { message: "Vim mode disabled", variant: "info" },
    ])
  } finally {
    host.cleanup?.()
    host.rendered.renderer.destroy()
  }
})

test("a durable setting rejection keeps Vim enabled and reports the failure", async () => {
  const host = await harness({
    setDurable: () => async () => {
      throw new Error("disk full")
    },
  })

  try {
    host.editor.plainText = "xa"
    host.editor.cursorOffset = 1
    await command(host.layers, "vimcode-v2.toggle")!.run()
    const history = host.session.histories.get(host.editor as any)!
    expect(host.settings.enabled).toBe(true)
    expect(history.changeSession).not.toBeNull()
    expect(history.undo).toHaveLength(0)
    expect(host.toasts).toEqual([
      {
        message: "Failed to update Vim mode: disk full",
        variant: "error",
      },
    ])
  } finally {
    host.cleanup?.()
    host.rendered.renderer.destroy()
  }
})

test("overlapping toggles serialize against durable state", async () => {
  const gates = [deferred<void>(), deferred<void>()]
  let writes = 0
  const host = await harness({
    setDurable: (settings, apply) => async (mutation) => {
      const draft = { enabled: settings.enabled }
      mutation(draft)
      const gate = gates[writes++]!
      await gate.promise
      apply(draft.enabled)
    },
  })

  try {
    const toggle = command(host.layers, "vimcode-v2.toggle")!
    const first = toggle.run()
    const second = toggle.run()
    await Promise.resolve()
    expect(writes).toBe(1)
    gates[0]!.resolve()
    await first
    await Promise.resolve()
    expect(writes).toBe(2)
    gates[1]!.resolve()
    await second
    expect(host.settings.enabled).toBe(true)
    expect(host.toasts.map((toast) => toast.message)).toEqual([
      "Vim mode disabled",
      "Vim mode enabled",
    ])
  } finally {
    host.cleanup?.()
    host.rendered.renderer.destroy()
  }
})

test("plugin disposal fences a pending durable toggle", async () => {
  const persisted = deferred<void>()
  const host = await harness({
    setDurable: (settings, apply) => async (mutation) => {
      const draft = { enabled: settings.enabled }
      mutation(draft)
      await persisted.promise
      apply(draft.enabled)
    },
  })

  const pending = command(host.layers, "vimcode-v2.toggle")!.run()
  host.cleanup?.()
  persisted.resolve()
  await pending
  expect(host.toasts).toEqual([])
  expect(host.editor.cursorStyle).toEqual({ style: "line", blinking: true })
  host.rendered.renderer.destroy()
})

test("leaving normal host mode finalizes the active insert session", async () => {
  const host = await harness()

  try {
    host.editor.plainText = "xa"
    host.editor.cursorOffset = 1
    host.setHostMode("shell")
    await host.rendered.flush()
    await Bun.sleep(60)
    const history = host.session.histories.get(host.editor as any)!
    expect(history.changeSession).toBeNull()
    expect(history.undo).toHaveLength(1)
  } finally {
    host.cleanup?.()
    host.rendered.renderer.destroy()
  }
})

test("plugin disposal fences a pending EX prompt", async () => {
  const prompt = deferred<string | undefined>()
  const host = await harness({
    mode: "normal",
    prompt: () => prompt.promise,
  })

  try {
    const ex = host.layers
      .flatMap((layer) => layer().commands ?? [])
      .find((candidate) => candidate.bind === "shift+semicolon")
    expect(ex).toBeDefined()
    ex.run()
    host.cleanup?.()
    prompt.resolve(":review late")
    await Promise.resolve()
    await Promise.resolve()
    expect(host.dispatched).toEqual([])
    expect(host.alerts).toEqual([])
  } finally {
    host.rendered.renderer.destroy()
  }
})
