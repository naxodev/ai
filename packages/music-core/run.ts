import { execFile, spawnSync } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type CommandResult =
  { ok: true; out: string } | { ok: false; err: string; timed_out: boolean }

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
