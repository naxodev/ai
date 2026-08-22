import { execFile, spawn, spawnSync } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const MAX_LINE_STREAM_PARTIAL_BYTES = 64 * 1024

export type CommandResult =
  { ok: true; out: string } | { ok: false; err: string; timed_out: boolean }

export type LineStreamCallbacks = {
  onLine: (line: string) => void
  onTerminal: () => void
}

export type LineStreamDisposer = () => void

export type LineStreamStarter = (
  cmd: string[],
  callbacks: LineStreamCallbacks,
) => LineStreamDisposer

export type LineStreamProcess = {
  stdout: {
    on: (event: "data", listener: (chunk: Buffer | string) => void) => unknown
    removeListener: (
      event: "data",
      listener: (chunk: Buffer | string) => void,
    ) => unknown
  } | null
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  on: (event: "error" | "exit" | "close", listener: () => void) => unknown
  removeListener: (
    event: "error" | "exit" | "close",
    listener: () => void,
  ) => unknown
  kill: () => unknown
}

export type LineStreamSpawner = (
  bin: string,
  args: string[],
) => LineStreamProcess

/**
 * Starts a command and forwards complete non-empty stdout lines. The returned
 * disposer owns the process and suppresses all notifications after disposal.
 */
export function startLineStream(
  cmd: string[],
  callbacks: LineStreamCallbacks,
  spawnProcess: LineStreamSpawner = (bin, args) =>
    spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] }),
): LineStreamDisposer {
  const [bin, ...args] = cmd
  if (!bin) {
    queueMicrotask(callbacks.onTerminal)
    return () => {}
  }

  const child = spawnProcess(bin, args)
  let buffer = ""
  let disposed = false
  let terminated = false
  let killRequested = false

  const kill = () => {
    if (killRequested || child.exitCode !== null || child.signalCode !== null)
      return
    killRequested = true
    try {
      child.kill()
    } catch {
      // A process can exit between the state check and kill.
    }
  }

  const terminal = () => {
    if (disposed || terminated) return
    terminated = true
    callbacks.onTerminal()
  }
  const onData = (chunk: Buffer | string) => {
    if (disposed || terminated) return
    buffer += String(chunk)
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (disposed) return
      if (line) callbacks.onLine(line)
    }
    if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_STREAM_PARTIAL_BYTES) {
      buffer = ""
      kill()
      terminal()
    }
  }

  child.stdout?.on("data", onData)
  child.on("error", terminal)
  child.on("exit", terminal)
  child.on("close", terminal)

  return () => {
    if (disposed) return
    disposed = true
    buffer = ""
    child.stdout?.removeListener("data", onData)
    child.removeListener("error", terminal)
    child.removeListener("exit", terminal)
    child.removeListener("close", terminal)
    kill()
  }
}

/** True when `which bin` exits 0. */
export function whichOk(bin: string): boolean {
  const r = spawnSync("which", [bin], { stdio: "ignore", timeout: 2000 })
  return r.status === 0
}

/**
 * Portable CLI runner (node:child_process) shared by Pi and OpenCode hosts.
 * On timeout kills the child and returns timed_out: true with a stable err string.
 */
export async function run(
  cmd: string[],
  timeoutMs = 2_000,
): Promise<CommandResult> {
  const [bin, ...args] = cmd
  if (!bin) return { ok: false, err: "empty command", timed_out: false }

  try {
    const { stdout } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      killSignal: "SIGKILL",
    })
    return { ok: true, out: String(stdout).trim() }
  } catch (e: unknown) {
    const err = e as {
      code?: number | string
      killed?: boolean
      signal?: NodeJS.Signals | number | null
      stdout?: string
      stderr?: string
      message?: string
    }

    const timedOut =
      err.killed === true ||
      err.signal === "SIGKILL" ||
      err.code === "ETIMEDOUT" ||
      (typeof err.message === "string" &&
        (err.message.includes("ETIMEDOUT") ||
          err.message.toLowerCase().includes("timed out")))

    if (timedOut) {
      return {
        ok: false,
        err: `command timed out after ${timeoutMs}ms`,
        timed_out: true,
      }
    }

    const stderr = err.stderr != null ? String(err.stderr).trim() : ""
    const stdout = err.stdout != null ? String(err.stdout).trim() : ""
    const code =
      typeof err.code === "number"
        ? err.code
        : typeof err.code === "string"
          ? err.code
          : "?"
    return {
      ok: false,
      err:
        stderr || stdout || (typeof code === "number" ? `exit ${code}` : code),
      timed_out: false,
    }
  }
}
