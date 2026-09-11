import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import {
  clipboardCandidates,
  createClipboardWriter,
  isClipboardOption,
  selectClipboardProvider,
  type ClipboardDependencies,
  type ClipboardProcess,
} from "../clipboard.ts"

function dependencies(
  overrides: Partial<ClipboardDependencies> = {},
): ClipboardDependencies {
  return {
    platform: "linux",
    env: {},
    isExecutable: () => true,
    spawn: () => processStub(),
    warn() {},
    timeoutMs: 2_000,
    ...overrides,
  }
}

function processStub(
  overrides: Partial<ClipboardProcess> = {},
): ClipboardProcess {
  return {
    stdin: {
      end() {},
      on() {},
    },
    on() {},
    ...overrides,
  }
}

function simulatedProvider() {
  const events = new EventEmitter()
  const signals: (NodeJS.Signals | undefined)[] = []
  const terminated = Promise.withResolvers<void>()
  const killed = Promise.withResolvers<void>()
  let text = ""
  const child = Object.assign(events, {
    stdin: Object.assign(new EventEmitter(), {
      end(value: string) {
        text = value
      },
    }),
    kill(signal?: NodeJS.Signals) {
      signals.push(signal ?? "SIGTERM")
      if (signal === "SIGKILL") killed.resolve()
      else terminated.resolve()
      return true
    },
  })
  return {
    child,
    signals,
    text: () => text,
    terminated: terminated.promise,
    killed: killed.promise,
  }
}

async function awaitSignal(signal: Promise<void>) {
  // Fake providers have no process handle to keep unref'd cleanup timers live.
  // Keep this wait referenced, and fail if the writer never sends the signal.
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Provider signal was not sent within 1s")),
          1_000,
        )
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

describe("clipboard provider selection", () => {
  test("accepts only fixed provider names", () => {
    expect(isClipboardOption("wl-copy")).toBe(true)
    expect(isClipboardOption("sh -c pbcopy")).toBe(false)
    expect(isClipboardOption(["pbcopy", "--arg"])).toBe(false)
  })

  test("prefers Wayland, then X11 providers on a mixed Linux session", () => {
    expect(
      clipboardCandidates("linux", {
        WAYLAND_DISPLAY: "wayland-0",
        DISPLAY: ":0",
      }),
    ).toEqual(["wl-copy", "xclip", "xsel"])
    expect(
      selectClipboardProvider(
        "auto",
        dependencies({
          env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
          isExecutable: (command) => command === "xclip",
        }),
      ),
    ).toBe("xclip")
  })

  test("uses X11 provider order when only DISPLAY is set", () => {
    const checked: string[] = []
    expect(
      selectClipboardProvider(
        "auto",
        dependencies({
          env: { DISPLAY: ":0" },
          isExecutable(command) {
            checked.push(command)
            return command === "xsel"
          },
        }),
      ),
    ).toBe("xsel")
    expect(checked).toEqual(["xclip", "xsel"])
  })

  test("uses the native macOS and Windows providers", () => {
    expect(
      selectClipboardProvider("auto", dependencies({ platform: "darwin" })),
    ).toBe("pbcopy")
    expect(
      selectClipboardProvider("auto", dependencies({ platform: "win32" })),
    ).toBe("clip")
  })

  test("none disables probing, spawning, and warnings", () => {
    let calls = 0
    const write = createClipboardWriter(
      "none",
      dependencies({
        isExecutable() {
          calls++
          return true
        },
        spawn() {
          calls++
          return processStub()
        },
        warn() {
          calls++
        },
      }),
    )
    write("ignored")
    expect(calls).toBe(0)
  })

  test("missing commands warn once and disable clipboard writes", () => {
    const warnings: string[] = []
    let spawns = 0
    const write = createClipboardWriter(
      "auto",
      dependencies({
        env: { DISPLAY: ":0" },
        isExecutable: () => false,
        spawn() {
          spawns++
          return processStub()
        },
        warn: (message) => warnings.push(message),
      }),
    )
    write("first")
    write("second")
    expect(spawns).toBe(0)
    expect(warnings).toHaveLength(1)
  })
})

describe("clipboard invocation", () => {
  test("a timed-out provider owns the clipboard until exit, including kill escalation", async () => {
    const first = simulatedProvider()
    const second = simulatedProvider()
    const third = simulatedProvider()
    let spawns = 0
    const warnings: string[] = []
    const write = createClipboardWriter(
      "pbcopy",
      dependencies({
        timeoutMs: 5,
        spawn: () => [first, second, third][spawns++]!.child,
        warn: (message) => warnings.push(message),
      }),
    )
    try {
      write("stalled")
      write("pending")
      await awaitSignal(first.terminated)
      expect(first.signals).toEqual(["SIGTERM"])
      expect(spawns).toBe(1)
      write("newest")
      expect(spawns).toBe(1)
      await awaitSignal(first.killed)
      expect(first.signals).toEqual(["SIGTERM", "SIGKILL"])
      expect(spawns).toBe(1)
      first.child.emit("exit", null)
      expect(spawns).toBe(2)
      expect(second.text()).toBe("newest")
      // A late close from the old process must not complete the new write.
      first.child.emit("close", null)
      write("")
      expect(spawns).toBe(2)
      second.child.emit("exit", 0)
      expect(spawns).toBe(3)
      expect(third.text()).toBe("")
      third.child.emit("exit", 0)
      expect(warnings).toHaveLength(1)
    } finally {
      write.dispose()
    }
  })

  test("disposal drops pending yanks but still reaps a provider that ignores SIGTERM", async () => {
    const provider = simulatedProvider()
    let spawns = 0
    const warnings: string[] = []
    const write = createClipboardWriter(
      "pbcopy",
      dependencies({
        spawn() {
          spawns++
          return provider.child
        },
        warn: (message) => warnings.push(message),
      }),
    )
    write("active")
    write("pending")
    expect(write.dispose()).toBeUndefined()
    write.dispose()
    write("after disposal")
    provider.child.stdin.emit("error", new Error("closed pipe"))
    provider.child.emit("error", new Error("termination error"))
    await awaitSignal(provider.killed)
    provider.child.emit("exit", null)
    provider.child.emit("close", null)
    expect(provider.signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(spawns).toBe(1)
    expect(warnings).toEqual([])
  })

  test.each(["stdin error", "stdin throw", "process error"])(
    "%s retains ownership until termination and then runs the latest yank",
    async (failure) => {
      const first = simulatedProvider()
      const second = simulatedProvider()
      let spawns = 0
      const warnings: string[] = []
      if (failure === "stdin throw") {
        first.child.stdin.end = () => {
          throw new Error("write failed")
        }
      }
      const write = createClipboardWriter(
        "pbcopy",
        dependencies({
          spawn: () => (++spawns === 1 ? first.child : second.child),
          warn: (message) => warnings.push(message),
        }),
      )
      try {
        expect(() => write("failed")).not.toThrow()
        write("latest")
        if (failure === "stdin error") first.child.stdin.emit("error")
        if (failure === "process error") first.child.emit("error")
        await awaitSignal(first.killed)
        expect(spawns).toBe(1)
        first.child.emit("close", null)
        expect(spawns).toBe(2)
        expect(second.text()).toBe("latest")
        second.child.emit("exit", 0)
        expect(warnings).toHaveLength(1)
      } finally {
        write.dispose()
      }
    },
  )

  test("spawn failure does not prevent a later yank", () => {
    const provider = simulatedProvider()
    let spawns = 0
    const write = createClipboardWriter(
      "pbcopy",
      dependencies({
        spawn() {
          if (++spawns === 1) throw new Error("spawn failed")
          return provider.child
        },
      }),
    )
    try {
      expect(() => write("failed")).not.toThrow()
      write("latest")
      expect(provider.text()).toBe("latest")
      provider.child.emit("exit", 0)
    } finally {
      write.dispose()
    }
  })

  test("a delayed older yank cannot overwrite the latest requested clipboard text", () => {
    let clipboard = ""
    const running: { finish(): void }[] = []
    const inputs: string[] = []
    const write = createClipboardWriter(
      "pbcopy",
      dependencies({
        spawn() {
          let text = ""
          let exit: ((code: number | null) => void) | undefined
          running.push({
            finish() {
              clipboard = text
              exit?.(0)
            },
          })
          return processStub({
            stdin: {
              on() {},
              end(value) {
                text = value
                inputs.push(value)
              },
            },
            on(event, listener) {
              if (event === "exit") exit = listener
            },
          })
        },
      }),
    )
    try {
      expect(write("older")).toBeUndefined()
      expect(write("intermediate")).toBeUndefined()
      expect(write("latest 😀\n")).toBeUndefined()
      // Finish every newer process first if concurrent writes were allowed.
      for (const child of running.slice(1).reverse()) child.finish()
      running[0]!.finish()
      expect(running).toHaveLength(2)
      running[1]!.finish()
      expect(inputs).toEqual(["older", "latest 😀\n"])
      expect(clipboard).toBe("latest 😀\n")
    } finally {
      write.dispose()
    }
  })

  test("passes exact UTF-8 text through stdin without a shell", () => {
    let input: [string, BufferEncoding] | undefined
    let invocation: unknown[] | undefined
    const write = createClipboardWriter(
      "xclip",
      dependencies({
        spawn(command, args, options) {
          invocation = [command, args, options]
          return processStub({
            stdin: {
              on() {},
              end(text, encoding) {
                input = [text, encoding]
              },
            },
          })
        },
      }),
    )
    write("first\nsecond\n")
    expect(input).toEqual(["first\nsecond\n", "utf8"])
    expect(invocation).toEqual([
      "xclip",
      ["-selection", "clipboard"],
      {
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      },
    ])
  })

  test("contains spawn and process write failures and warns only once", () => {
    const warnings: string[] = []
    expect(() =>
      createClipboardWriter(
        "pbcopy",
        dependencies({
          spawn() {
            throw new Error("spawn failed")
          },
          warn: (message) => warnings.push(message),
        }),
      )("text"),
    ).not.toThrow()

    let failProcess: (() => void) | undefined
    const write = createClipboardWriter(
      "pbcopy",
      dependencies({
        spawn: () =>
          processStub({
            on(event, listener) {
              if (event === "error") failProcess = listener as () => void
            },
          }),
        warn: (message) => warnings.push(message),
      }),
    )
    write("text")
    failProcess?.()
    failProcess?.()
    expect(warnings).toHaveLength(2)
  })

  test("uses a fixed Unicode-safe Windows invocation", () => {
    let invocation: unknown[] | undefined
    const write = createClipboardWriter(
      "clip",
      dependencies({
        platform: "win32",
        spawn(command, args, options) {
          invocation = [command, args, options.shell]
          return processStub()
        },
      }),
    )
    write("Zażółć 😀\n")
    expect(invocation).toEqual([
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())",
      ],
      false,
    ])
  })

  test("kills hung providers and disposes active children", async () => {
    let kills = 0
    let exit: ((code: number | null) => void) | undefined
    const warnings: string[] = []
    const write = createClipboardWriter(
      "pbcopy",
      dependencies({
        timeoutMs: 1,
        spawn: () =>
          processStub({
            kill() {
              kills++
              exit?.(null)
              return true
            },
            on(event, listener) {
              if (event === "exit") exit = listener
            },
          }),
        warn: (message) => warnings.push(message),
      }),
    )
    write("hung")
    await Bun.sleep(10)
    expect(kills).toBe(1)
    expect(warnings).toHaveLength(1)

    write("active")
    write.dispose()
    expect(kills).toBe(2)
  })

  test("suppresses killed-child failures and ignores writes after disposal", () => {
    let spawns = 0
    let kills = 0
    let fail: (() => void) | undefined
    const warnings: string[] = []
    const write = createClipboardWriter(
      "pbcopy",
      dependencies({
        spawn: () => {
          spawns++
          return processStub({
            kill: () => (kills++, true),
            on(event, listener) {
              if (event === "error") fail = listener as () => void
            },
          })
        },
        warn: (message) => warnings.push(message),
      }),
    )

    write("active")
    write.dispose()
    fail?.()
    write("late")

    expect(kills).toBe(1)
    expect(spawns).toBe(1)
    expect(warnings).toEqual([])
  })
})
