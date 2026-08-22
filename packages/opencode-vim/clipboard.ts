import { spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"

export const clipboardOptions = [
  "auto",
  "none",
  "pbcopy",
  "wl-copy",
  "xclip",
  "xsel",
  "clip",
] as const

export type ClipboardOption = (typeof clipboardOptions)[number]
export type ClipboardProvider = Exclude<ClipboardOption, "auto" | "none">

type Platform = NodeJS.Platform
type Environment = Readonly<Record<string, string | undefined>>

export interface ClipboardProcess {
  stdin: {
    end(text: string, encoding: BufferEncoding): void
    on(event: "error", listener: () => void): unknown
  }
  on(event: "error", listener: () => void): unknown
  on(event: "exit", listener: (code: number | null) => void): unknown
  kill?(): boolean
}

export interface ClipboardDependencies {
  platform: Platform
  env: Environment
  isExecutable(command: string): boolean
  spawn(
    command: string,
    args: readonly string[],
    options: {
      shell: false
      stdio: ["pipe", "ignore", "ignore"]
      windowsHide: true
    },
  ): ClipboardProcess
  warn(message: string): void
  timeoutMs: number
}

const providerInvocation: Record<
  ClipboardProvider,
  { command: string; args: readonly string[] }
> = {
  pbcopy: { command: "pbcopy", args: [] },
  "wl-copy": { command: "wl-copy", args: [] },
  xclip: { command: "xclip", args: ["-selection", "clipboard"] },
  xsel: { command: "xsel", args: ["--clipboard", "--input"] },
  clip: {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())",
    ],
  },
}

export function isClipboardOption(value: unknown): value is ClipboardOption {
  return clipboardOptions.some((option) => option === value)
}

export function clipboardCandidates(
  platform: Platform,
  env: Environment,
): readonly ClipboardProvider[] {
  if (platform === "darwin") return ["pbcopy"]
  if (platform === "win32") return ["clip"]
  if (platform !== "linux") return []

  const candidates: ClipboardProvider[] = []
  if (env.WAYLAND_DISPLAY) candidates.push("wl-copy")
  if (env.DISPLAY) candidates.push("xclip", "xsel")
  return candidates
}

export function selectClipboardProvider(
  option: ClipboardOption,
  dependencies: Pick<
    ClipboardDependencies,
    "platform" | "env" | "isExecutable"
  >,
): ClipboardProvider | undefined {
  if (option === "none") return undefined
  const candidates =
    option === "auto"
      ? clipboardCandidates(dependencies.platform, dependencies.env)
      : [option]
  return candidates.find((provider) =>
    dependencies.isExecutable(providerInvocation[provider].command),
  )
}

export type ClipboardWriter = ((text: string) => void) & { dispose(): void }

export function createClipboardWriter(
  option: ClipboardOption,
  overrides: Partial<ClipboardDependencies> = {},
): ClipboardWriter {
  const dependencies = { ...defaultDependencies, ...overrides }
  const provider = selectClipboardProvider(option, dependencies)
  let warned = false
  let disposed = false
  const children = new Set<ClipboardProcess>()
  const timers = new Map<ClipboardProcess, ReturnType<typeof setTimeout>>()
  const warnOnce = (message: string) => {
    if (disposed || warned) return
    warned = true
    try {
      dependencies.warn(message)
    } catch {}
  }

  if (!provider && option !== "none")
    warnOnce(
      option === "auto"
        ? "System clipboard unavailable; yanks remain in the Vim register"
        : `${option} is unavailable; yanks remain in the Vim register`,
    )

  const write = (text: string) => {
    if (disposed || !provider) return
    try {
      const invocation = providerInvocation[provider]
      const child = dependencies.spawn(invocation.command, invocation.args, {
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      })
      const failed = () =>
        warnOnce(
          "System clipboard write failed; yank remains in the Vim register",
        )
      children.add(child)
      const timeout = setTimeout(() => {
        child.kill?.()
        children.delete(child)
        timers.delete(child)
        failed()
      }, dependencies.timeoutMs)
      timeout.unref()
      timers.set(child, timeout)
      const complete = () => {
        clearTimeout(timeout)
        timers.delete(child)
        children.delete(child)
      }
      child.on("error", () => {
        complete()
        failed()
      })
      child.on("exit", (code) => {
        complete()
        if (code !== 0) failed()
      })
      child.stdin.on("error", failed)
      child.stdin.end(text, "utf8")
    } catch {
      warnOnce(
        "System clipboard write failed; yank remains in the Vim register",
      )
    }
  }
  return Object.assign(write, {
    dispose() {
      if (disposed) return
      disposed = true
      for (const child of children) {
        const timeout = timers.get(child)
        if (timeout) clearTimeout(timeout)
        child.kill?.()
      }
      children.clear()
      timers.clear()
    },
  })
}

function executableOnPath(command: string): boolean {
  const path = process.env.PATH
  if (!path) return false
  const extensions =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")]
      : [""]
  return path.split(delimiter).some((directory) =>
    extensions.some((extension) => {
      try {
        accessSync(join(directory, `${command}${extension}`), constants.X_OK)
        return true
      } catch {
        return false
      }
    }),
  )
}

const defaultDependencies: ClipboardDependencies = {
  platform: process.platform,
  env: process.env,
  isExecutable: executableOnPath,
  spawn: (command, args, options) => spawn(command, args, options),
  warn() {},
  timeoutMs: 2_000,
}
