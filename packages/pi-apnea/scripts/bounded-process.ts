export class CommandDeadlineError extends Error {}

class OutputLimitError extends Error {
  constructor(
    readonly stream: "stdout" | "stderr",
    readonly limitBytes: number,
  ) {
    super(`${stream} exceeded the ${limitBytes}-byte output limit`)
  }
}

class OutputReadError extends Error {
  constructor(
    readonly stream: "stdout" | "stderr",
    readonly reason: unknown,
  ) {
    super(reason instanceof Error ? reason.message : String(reason), {
      cause: reason,
    })
  }
}

class ProcessSetupError extends Error {
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason), {
      cause: reason,
    })
  }
}

export const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024

export type BoundedCommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

type SpawnedChild = {
  pid: number
  exited: Promise<number>
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  stdin: { write: (data: string) => unknown; end: () => unknown }
  kill: (signal: NodeJS.Signals) => unknown
}

type SpawnOptions = {
  cwd?: string
  detached: boolean
  stdin: "pipe"
  stdout: "pipe"
  stderr: "pipe"
}

export type BoundedProcessDeps = {
  spawn: (args: string[], options: SpawnOptions) => SpawnedChild
  waitForDeadline: <T>(promise: Promise<T>, milliseconds: number) => Promise<T>
  signal: (
    child: SpawnedChild,
    signal: "SIGTERM" | "SIGKILL",
    processGroup: boolean,
  ) => void
  waitForProcessTreeExit: (
    child: SpawnedChild,
    processGroup: boolean,
    milliseconds: number,
  ) => Promise<boolean>
  platform?: NodeJS.Platform
  taskkill?: (pid: number, timeoutMs: number) => Promise<boolean>
}

export type BoundedCommandOptions = {
  cwd?: string
  label: string
  timeoutMs: number
  terminationGraceMs?: number
  stdin?: string
  processGroup?: boolean
  outputLimitBytes?: number
}

export type BoundedCommandRunner = (
  args: string[],
  options: BoundedCommandOptions,
) => Promise<BoundedCommandResult>

function waitForDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new CommandDeadlineError(
              `command timed out after ${milliseconds}ms`,
            ),
          ),
        milliseconds,
      )
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

type ProcessKill = (
  pid: number,
  signal?: NodeJS.Signals | number,
) => boolean | void

export function signalChild(
  child: SpawnedChild,
  signal: "SIGTERM" | "SIGKILL",
  processGroup: boolean,
  kill: ProcessKill = process.kill,
): boolean {
  try {
    if (processGroup) kill(-child.pid, signal)
    else child.kill(signal)
    return true
  } catch {
    return false
  }
}

export function processTreeIsRunning(
  child: SpawnedChild,
  processGroup: boolean,
  kill: ProcessKill = process.kill,
): boolean | null {
  try {
    kill(processGroup ? -child.pid : child.pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    return null
  }
}

async function waitForProcessTreeExit(
  child: SpawnedChild,
  processGroup: boolean,
  milliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + milliseconds
  while (processTreeIsRunning(child, processGroup) !== false) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await Bun.sleep(Math.min(25, remaining))
  }
  return true
}

async function taskkillTree(pid: number, timeoutMs: number): Promise<boolean> {
  let killer: ReturnType<typeof Bun.spawn>
  try {
    killer = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    })
  } catch {
    return false
  }
  try {
    return (await waitForDeadline(killer.exited, timeoutMs)) === 0
  } catch {
    try {
      killer.kill("SIGKILL")
    } catch {
      // Direct child termination below remains the fallback.
    }
    return false
  }
}

const defaultDeps: BoundedProcessDeps = {
  spawn: (args, options) => Bun.spawn(args, options) as unknown as SpawnedChild,
  waitForDeadline,
  signal: signalChild,
  waitForProcessTreeExit,
  platform: process.platform,
  taskkill: taskkillTree,
}

type OutputCapture = {
  done: Promise<string>
  text: () => string
}

function captureOutput(
  stream: ReadableStream<Uint8Array>,
  name: "stdout" | "stderr",
  limitBytes: number,
): OutputCapture {
  let text = ""
  const done = (async () => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let capturedBytes = 0
    try {
      while (true) {
        const next = await reader.read().catch((error) => {
          throw new OutputReadError(name, error)
        })
        if (next.done) {
          text += decoder.decode()
          return text
        }

        const remaining = limitBytes - capturedBytes
        const captured = next.value.subarray(0, Math.max(0, remaining))
        capturedBytes += captured.byteLength
        text += decoder.decode(captured, { stream: true })
        if (captured.byteLength < next.value.byteLength) {
          text += decoder.decode()
          await reader.cancel().catch(() => {})
          throw new OutputLimitError(name, limitBytes)
        }
      }
    } finally {
      reader.releaseLock()
    }
  })()
  return { done, text: () => text }
}

async function terminateProcessTree(
  child: SpawnedChild,
  processGroup: boolean,
  graceMs: number,
  deps: BoundedProcessDeps,
): Promise<boolean> {
  if ((deps.platform ?? process.platform) === "win32") {
    if (await (deps.taskkill ?? taskkillTree)(child.pid, graceMs)) return true
    deps.signal(child, "SIGKILL", false)
    await deps.waitForProcessTreeExit(child, false, graceMs)
    // Parent exit cannot prove that taskkill reached every descendant.
    return false
  }
  deps.signal(child, "SIGTERM", processGroup)
  if (await deps.waitForProcessTreeExit(child, processGroup, graceMs))
    return true
  deps.signal(child, "SIGKILL", processGroup)
  return deps.waitForProcessTreeExit(child, processGroup, graceMs)
}

function capturedDiagnostics(
  stdout: OutputCapture,
  stderr: OutputCapture,
): string {
  return `stdout:\n${stdout.text()}\nstderr:\n${stderr.text()}`
}

export async function runBoundedCommand(
  args: string[],
  options: BoundedCommandOptions,
  deps: BoundedProcessDeps = defaultDeps,
): Promise<BoundedCommandResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`${options.label} timeout must be a positive finite number`)
  }
  const graceMs = options.terminationGraceMs ?? 5_000
  if (!Number.isFinite(graceMs) || graceMs <= 0) {
    throw new Error(
      `${options.label} termination grace must be a positive finite number`,
    )
  }
  const outputLimitBytes =
    options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES
  if (!Number.isInteger(outputLimitBytes) || outputLimitBytes <= 0) {
    throw new Error(
      `${options.label} output limit must be a positive integer number of bytes`,
    )
  }
  const platform = deps.platform ?? process.platform
  const processGroup =
    options.processGroup ?? (platform !== "win32" ? true : false)
  const child = deps.spawn(args, {
    cwd: options.cwd,
    detached: processGroup,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  let stdout: OutputCapture | undefined
  let stderr: OutputCapture | undefined
  let completed: [number, string, string]
  try {
    stdout = captureOutput(child.stdout, "stdout", outputLimitBytes)
    stderr = captureOutput(child.stderr, "stderr", outputLimitBytes)
    const completion = Promise.all([child.exited, stdout.done, stderr.done])
    try {
      if (options.stdin !== undefined) child.stdin.write(options.stdin)
      child.stdin.end()
    } catch (error) {
      throw new ProcessSetupError(error)
    }
    completed = await deps.waitForDeadline(completion, options.timeoutMs)
  } catch (error) {
    const cleaned = await terminateProcessTree(
      child,
      processGroup,
      graceMs,
      deps,
    )
    if (!cleaned) {
      const failure =
        error instanceof CommandDeadlineError
          ? `${options.label} timed out after ${options.timeoutMs}ms`
          : `${options.label} failed`
      throw new Error(`${failure} and did not exit after SIGKILL`, {
        cause: error,
      })
    }
    const diagnostics =
      stdout && stderr
        ? capturedDiagnostics(stdout, stderr)
        : "stdout:\n\nstderr:\n"
    if (error instanceof CommandDeadlineError) {
      throw new Error(
        `${options.label} timed out after ${options.timeoutMs}ms\n${diagnostics}`,
        { cause: error },
      )
    }
    if (error instanceof OutputLimitError) {
      throw new Error(`${options.label} ${error.message}\n${diagnostics}`, {
        cause: error,
      })
    }
    if (error instanceof OutputReadError) {
      throw new Error(
        `${options.label} output capture failed: ${error.message}\n${diagnostics}`,
        { cause: error },
      )
    }
    if (error instanceof ProcessSetupError) {
      throw new Error(
        `${options.label} process setup failed: ${error.message}\n${diagnostics}`,
        { cause: error },
      )
    }
    throw error
  }

  const [exitCode, capturedOut, capturedErr] = completed
  return { exitCode, stdout: capturedOut, stderr: capturedErr }
}
