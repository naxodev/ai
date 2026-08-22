import { spawn, type ChildProcess } from "node:child_process"
import { Context, Effect, Layer } from "effect"

export const DEFAULT_PROCESS_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024
export const DEFAULT_PROCESS_TERMINATION_GRACE_MS = 250

export type ProcessResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

type ProcessFailureFields = {
  readonly command: string
  readonly stdout: string
  readonly stderr: string
}

export class ProcessSpawnError extends Error {
  readonly _tag = "ProcessSpawnError"
  constructor(
    readonly command: string,
    readonly reason: unknown,
  ) {
    super(reason instanceof Error ? reason.message : String(reason), {
      cause: reason,
    })
  }
}

export class ProcessExitError extends Error implements ProcessFailureFields {
  readonly _tag = "ProcessExitError"
  constructor(
    readonly command: string,
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`${command} exited with code ${exitCode}`)
  }
}

export class ProcessTimeoutError extends Error implements ProcessFailureFields {
  readonly _tag = "ProcessTimeoutError"
  constructor(
    readonly command: string,
    readonly timeoutMs: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`${command} timed out after ${timeoutMs}ms`)
  }
}

export class ProcessCancelledError
  extends Error
  implements ProcessFailureFields
{
  readonly _tag = "ProcessCancelledError"
  constructor(
    readonly command: string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`${command} was cancelled`)
  }
}

export class ProcessOutputError extends Error implements ProcessFailureFields {
  readonly _tag = "ProcessOutputError"
  constructor(
    readonly command: string,
    readonly stream: "stdout" | "stderr",
    readonly limitBytes: number,
    readonly stdout: string,
    readonly stderr: string,
    readonly reason?: unknown,
  ) {
    super(
      reason === undefined
        ? `${stream} exceeded the ${limitBytes}-byte output limit`
        : `${stream} capture failed: ${reason instanceof Error ? reason.message : String(reason)}`,
      reason === undefined ? undefined : { cause: reason },
    )
  }
}

export type ProcessError =
  | ProcessSpawnError
  | ProcessExitError
  | ProcessTimeoutError
  | ProcessCancelledError
  | ProcessOutputError

export type ProcessOptions = {
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly stdin?: string
  readonly timeoutMs: number
  readonly outputLimitBytes?: number
  readonly terminationGraceMs?: number
  readonly signal?: AbortSignal
}

export interface ProcessService {
  readonly run: (
    options: ProcessOptions,
  ) => Effect.Effect<ProcessResult, ProcessError>
}

export class Process extends Context.Service<Process, ProcessService>()(
  "apnea/Process",
) {}

export type ProcessChild = Pick<ChildProcess, "pid" | "kill">

type ProcessKill = (
  pid: number,
  signal?: NodeJS.Signals | number,
) => boolean | void

export type ProcessRuntimeDeps = {
  readonly spawn?: typeof spawn
  readonly platform: NodeJS.Platform
  readonly kill: ProcessKill
  readonly sleep: (milliseconds: number) => Promise<void>
  readonly snapshotDescendants: (pid: number) => Promise<number[]>
  readonly taskkill: (pid: number, timeoutMs: number) => Promise<boolean>
  readonly processRunning: (pid: number) => boolean
}

function safeKill(
  kill: ProcessKill,
  pid: number,
  signal: NodeJS.Signals,
): void {
  try {
    kill(pid, signal)
  } catch {
    // A concurrently exited process needs no further termination.
  }
}

function childKill(child: ProcessChild, signal: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    // A concurrently exited process needs no further termination.
  }
}

async function waitUntilStopped(
  pids: readonly number[],
  timeoutMs: number,
  deps: ProcessRuntimeDeps,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  while (pids.some((pid) => deps.processRunning(pid))) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) return false
    await deps.sleep(Math.min(25, remaining))
  }
  return true
}

export async function terminateProcessTree(
  child: ProcessChild,
  graceMs: number,
  deps: ProcessRuntimeDeps = defaultRuntimeDeps,
): Promise<void> {
  const pid = child.pid
  if (pid === undefined) {
    childKill(child, "SIGKILL")
    return
  }

  if (deps.platform === "win32") {
    if (await deps.taskkill(pid, graceMs)) return
    childKill(child, "SIGKILL")
    return
  }

  // Snapshot first. A descendant may create a new session and escape the
  // process group, then become reparented as soon as the group leader exits.
  const descendants = await deps.snapshotDescendants(pid)
  const targets = [pid, ...descendants]
  safeKill(deps.kill, -pid, "SIGTERM")
  for (const descendant of descendants) {
    safeKill(deps.kill, descendant, "SIGTERM")
  }
  if (await waitUntilStopped(targets, graceMs, deps)) return

  safeKill(deps.kill, -pid, "SIGKILL")
  for (const descendant of descendants) {
    safeKill(deps.kill, descendant, "SIGKILL")
  }
  await waitUntilStopped(targets, graceMs, deps)
  childKill(child, "SIGKILL")
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

function collectBounded(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  limitBytes: number,
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(command, [...args], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      })
    } catch {
      resolve({ exitCode: 1, stdout: "" })
      return
    }
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, stdout: Buffer.concat(chunks).toString("utf8") })
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      const available = limitBytes - bytes
      if (available > 0) chunks.push(chunk.subarray(0, available))
      bytes += Math.min(chunk.length, Math.max(0, available))
      if (chunk.length > available) childKill(child, "SIGKILL")
    })
    child.once("error", () => finish(1))
    child.once("close", (code) => finish(code ?? 1))
    const timer = setTimeout(() => {
      childKill(child, "SIGKILL")
      finish(1)
    }, timeoutMs)
  })
}

async function snapshotDescendants(rootPid: number): Promise<number[]> {
  const snapshot = await collectBounded(
    "ps",
    ["-axo", "pid=,ppid="],
    2_000,
    DEFAULT_PROCESS_OUTPUT_LIMIT_BYTES,
  )
  if (snapshot.exitCode !== 0) return []
  const children = new Map<number, number[]>()
  for (const line of snapshot.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const parent = Number(match[2])
    const siblings = children.get(parent)
    if (siblings) siblings.push(pid)
    else children.set(parent, [pid])
  }
  const descendants: number[] = []
  const pending = [...(children.get(rootPid) ?? [])]
  for (let index = 0; index < pending.length; index++) {
    const pid = pending[index]!
    descendants.push(pid)
    pending.push(...(children.get(pid) ?? []))
  }
  return descendants
}

async function taskkill(pid: number, timeoutMs: number): Promise<boolean> {
  const result = await collectBounded(
    "taskkill",
    ["/PID", String(pid), "/T", "/F"],
    timeoutMs,
    64 * 1024,
  )
  return result.exitCode === 0
}

const defaultRuntimeDeps: ProcessRuntimeDeps = {
  platform: process.platform,
  kill: process.kill,
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  snapshotDescendants,
  taskkill,
  processRunning,
}

type Capture = {
  readonly chunks: Buffer[]
  bytes: number
}

function text(capture: Capture): string {
  return Buffer.concat(capture.chunks).toString("utf8")
}

export function makeProcessService(
  deps: ProcessRuntimeDeps = defaultRuntimeDeps,
): ProcessService {
  return Process.of({
    run: (options) =>
      Effect.callback<ProcessResult, ProcessError>((resume) => {
        const args = [...(options.args ?? [])]
        const label = [options.command, ...args].join(" ")
        const limit =
          options.outputLimitBytes ?? DEFAULT_PROCESS_OUTPUT_LIMIT_BYTES
        const grace =
          options.terminationGraceMs ?? DEFAULT_PROCESS_TERMINATION_GRACE_MS
        if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
          resume(
            Effect.fail(
              new ProcessTimeoutError(label, options.timeoutMs, "", ""),
            ),
          )
          return
        }
        if (!Number.isInteger(limit) || limit <= 0) {
          resume(
            Effect.fail(new ProcessOutputError(label, "stdout", limit, "", "")),
          )
          return
        }

        let child: ChildProcess
        try {
          child = (deps.spawn ?? spawn)(options.command, args, {
            cwd: options.cwd,
            env: options.env,
            detached: deps.platform !== "win32",
            stdio: [
              options.stdin === undefined ? "ignore" : "pipe",
              "pipe",
              "pipe",
            ],
            windowsHide: true,
          })
        } catch (error) {
          resume(Effect.fail(new ProcessSpawnError(label, error)))
          return
        }

        const stdout: Capture = { chunks: [], bytes: 0 }
        const stderr: Capture = { chunks: [], bytes: 0 }
        let spawned = false
        let settled = false
        let pendingError: ProcessError | undefined
        let cleanup: Promise<void> | undefined
        const terminate = () =>
          (cleanup ??= terminateProcessTree(child, grace, deps))
        const diagnostics = () => ({
          stdout: text(stdout),
          stderr: text(stderr),
        })
        const finish = (effect: Effect.Effect<ProcessResult, ProcessError>) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          options.signal?.removeEventListener("abort", onAbort)
          resume(effect)
        }
        const failAfterCleanup = (error: ProcessError) => {
          if (settled || pendingError !== undefined) return
          pendingError = error
          void terminate().then(() => finish(Effect.fail(error)))
        }
        const capture = (name: "stdout" | "stderr", chunk: Buffer) => {
          const target = name === "stdout" ? stdout : stderr
          const available = limit - target.bytes
          if (available > 0) target.chunks.push(chunk.subarray(0, available))
          target.bytes += Math.min(chunk.length, Math.max(0, available))
          if (chunk.length > available) {
            const captured = diagnostics()
            failAfterCleanup(
              new ProcessOutputError(
                label,
                name,
                limit,
                captured.stdout,
                captured.stderr,
              ),
            )
          }
        }
        const outputError = (name: "stdout" | "stderr", reason: unknown) => {
          const captured = diagnostics()
          failAfterCleanup(
            new ProcessOutputError(
              label,
              name,
              limit,
              captured.stdout,
              captured.stderr,
              reason,
            ),
          )
        }
        const onAbort = () => {
          const captured = diagnostics()
          failAfterCleanup(
            new ProcessCancelledError(label, captured.stdout, captured.stderr),
          )
        }

        child.once("spawn", () => {
          spawned = true
          if (options.stdin !== undefined) child.stdin?.end(options.stdin)
        })
        child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk))
        child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk))
        child.stdout?.once("error", (error) => outputError("stdout", error))
        child.stderr?.once("error", (error) => outputError("stderr", error))
        child.stdin?.once("error", (error) => {
          if (
            child.exitCode !== null ||
            (spawned && (error as NodeJS.ErrnoException).code === "EPIPE")
          ) {
            return
          }
          failAfterCleanup(new ProcessSpawnError(label, error))
        })
        child.once("error", (error) => {
          if (!spawned) finish(Effect.fail(new ProcessSpawnError(label, error)))
          else outputError("stderr", error)
        })
        child.once("close", (code) => {
          if (pendingError !== undefined) return
          const captured = diagnostics()
          const exitCode = code ?? 1
          finish(
            exitCode === 0
              ? Effect.succeed({ exitCode, ...captured })
              : Effect.fail(
                  new ProcessExitError(
                    label,
                    exitCode,
                    captured.stdout,
                    captured.stderr,
                  ),
                ),
          )
        })

        const timer = setTimeout(() => {
          const captured = diagnostics()
          failAfterCleanup(
            new ProcessTimeoutError(
              label,
              options.timeoutMs,
              captured.stdout,
              captured.stderr,
            ),
          )
        }, options.timeoutMs)
        if (options.signal?.aborted) onAbort()
        else options.signal?.addEventListener("abort", onAbort, { once: true })

        // Effect interruption runs this finalizer and waits for the process
        // tree to stop before the caller's cancellation can complete.
        return Effect.promise(terminate)
      }),
  })
}

export const ProcessLive = Layer.succeed(Process, makeProcessService())
