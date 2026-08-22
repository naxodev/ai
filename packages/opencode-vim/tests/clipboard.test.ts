import { describe, expect, test } from "bun:test"
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
    const warnings: string[] = []
    const write = createClipboardWriter(
      "pbcopy",
      dependencies({
        timeoutMs: 1,
        spawn: () => processStub({ kill: () => (kills++, true) }),
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
