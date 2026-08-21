import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Context, Effect, Layer } from "effect"
import {
  formatVerifyBlock,
  normalizeVerifySource,
  type VerifyBlock,
} from "../domain/verify-commands.ts"
import { VcsError } from "../errors.ts"
import type { VcsBackend } from "../domain/types.ts"
import { FileSystem } from "./file-system.ts"

export interface VcsService {
  readonly detect: (root: string) => Effect.Effect<VcsBackend | null>
  readonly isDirty: (root: string, vcs: VcsBackend) => Effect.Effect<boolean>
  readonly treeFingerprint: (
    root: string,
    vcs: VcsBackend,
  ) => Effect.Effect<string>
  readonly ensureGitBranch: (
    root: string,
    slug: string,
  ) => Effect.Effect<string, VcsError>
  readonly commitPhase: (
    root: string,
    vcs: VcsBackend,
    message: string,
  ) => Effect.Effect<string, VcsError>
  readonly setBookmarkAtTerminus: (
    root: string,
    slug: string,
  ) => Effect.Effect<void>
  readonly runVerify: (
    root: string,
    blocks: readonly VerifyBlock[],
    timeoutMs: number,
  ) => Effect.Effect<{ ok: boolean; log: string }>
}

export class Vcs extends Context.Service<Vcs, VcsService>()("apnea/Vcs") {}

function run(
  cmd: string,
  args: string[],
  cwd: string,
): { ok: boolean; stdout: string; stderr: string; code: number } {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? "").toString(),
    stderr: (r.stderr ?? "").toString(),
    code: r.status ?? 1,
  }
}

function verificationError(
  error: unknown,
  temporaryDirectory?: string,
): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return temporaryDirectory
    ? message.replaceAll(
        temporaryDirectory,
        "[temporary verification directory]",
      )
    : message
}

const VERIFY_LOG_LIMIT = 10 * 1024 * 1024
const VERIFY_KILL_CLOSE_GRACE_MS = 2_500
const VERIFY_RESULT_RESERVE = 2_048
const VERIFY_WRAPPER_SOURCE = `exec 2>&1
exec "$1" -e "$2"
`
const VERIFY_DISPLAY_LIMIT_NOTICE = `verification log limit of ${VERIFY_LOG_LIMIT} bytes would be exceeded by the verification block display; block was not executed`
const VERIFY_LOG_LIMIT_NOTICE = `verification log limit of ${VERIFY_LOG_LIMIT} bytes reached; output was truncated and verification stopped`
const VERIFY_LIMIT_NOTICE_RESERVE =
  1 +
  Math.max(
    Buffer.byteLength(VERIFY_DISPLAY_LIMIT_NOTICE),
    Buffer.byteLength(VERIFY_LOG_LIMIT_NOTICE),
  )

export function utf8BytesAfterAppend(
  usedBytes: number,
  limitBytes: number,
  text: string,
): number | null {
  const nextBytes = usedBytes + Buffer.byteLength(text)
  return nextBytes <= limitBytes ? nextBytes : null
}

class VerificationLog {
  readonly #chunks: string[] = []
  readonly #contentLimit: number
  #bytes = 0
  #limited = false

  constructor(readonly limit: number) {
    this.#contentLimit = Math.max(0, limit - VERIFY_LIMIT_NOTICE_RESERVE)
  }

  get remaining(): number {
    return this.#contentLimit - this.#bytes
  }

  canAppendBytes(bytes: number): boolean {
    return bytes <= this.remaining
  }

  append(text: string): boolean {
    const nextBytes = utf8BytesAfterAppend(
      this.#bytes,
      this.#contentLimit,
      text,
    )
    if (nextBytes === null) return false
    this.#chunks.push(text)
    this.#bytes = nextBytes
    return true
  }

  addLimitNotice(notice: string): void {
    if (this.#limited) return
    this.#limited = true
    const previous = this.#chunks.at(-1)
    if (this.#bytes > 0 && !previous?.endsWith("\n")) {
      this.#chunks.push("\n")
      this.#bytes += 1
    }
    this.#chunks.push(notice)
    this.#bytes += Buffer.byteLength(notice)
  }

  toString(): string {
    return this.#chunks.join("").trimEnd()
  }
}

export function verifyBlockDisplayByteLength(block: VerifyBlock): number {
  const source = block.source
  const bodyEnd = source.endsWith("\n") ? source.length - 1 : source.length
  let lineCount = 1
  for (let index = 0; index < bodyEnd; index++) {
    if (source.charCodeAt(index) === 10) lineCount += 1
  }
  const bodyBytes =
    Buffer.byteLength(source) - (bodyEnd < source.length ? 1 : 0)
  return (
    Buffer.byteLength(`${block.interpreter} -e [verification block]\n`) +
    bodyBytes +
    lineCount * 2
  )
}

async function taskkillTree(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let killer: ChildProcess
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }

    try {
      killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      })
    } catch {
      resolve(false)
      return
    }

    const timer = setTimeout(() => {
      try {
        killer.kill("SIGKILL")
      } catch {
        // The fallback below still targets the verification child.
      }
      finish(false)
    }, 2_000)
    killer.once("error", () => finish(false))
    killer.once("close", (code) => finish(code === 0))
  })
}

function snapshotProcessDescendants(rootPid: number): number[] {
  const snapshot = spawnSync("ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })
  if (snapshot.status !== 0 || snapshot.error) return []

  const children = new Map<number, number[]>()
  for (const line of (snapshot.stdout ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const parentPid = Number(match[2])
    const siblings = children.get(parentPid)
    if (siblings) siblings.push(pid)
    else children.set(parentPid, [pid])
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

async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (process.platform === "win32" && pid !== undefined) {
    if (await taskkillTree(pid)) return
  } else if (pid !== undefined) {
    const descendants = snapshotProcessDescendants(pid)
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // The process may have exited between timeout and termination.
    }
    for (const descendantPid of descendants) {
      try {
        process.kill(descendantPid, "SIGKILL")
      } catch {
        // Process-group termination may already have killed this descendant.
      }
    }
  }

  // This is also the fallback when Windows taskkill cannot kill the tree.
  try {
    child.kill("SIGKILL")
  } catch {
    // A concurrently exited child needs no further termination.
  }
}

type VerificationProcessResult = {
  code: number
  output: string
  error?: string
}

function runVerificationProcess(
  wrapper: string,
  interpreter: VerifyBlock["interpreter"],
  script: string,
  cwd: string,
  timeoutMs: number,
  outputLimit: number,
): Promise<VerificationProcessResult> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn("sh", [wrapper, interpreter, script], {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      })
    } catch (error) {
      resolve({
        code: 1,
        output: "",
        error: verificationError(error),
      })
      return
    }

    const output: Buffer[] = []
    let outputSize = 0
    let outputExceeded = false
    let processError: string | undefined
    let termination: Promise<void> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let postKillCompletion: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const terminate = (message: string) => {
      if (settled) return
      processError ??= message
      if (termination) return
      termination = killProcessTree(child)
      postKillCompletion = setTimeout(() => {
        child.stdout?.destroy()
        finish(1)
      }, VERIFY_KILL_CLOSE_GRACE_MS)
    }
    const capture = (chunk: Buffer) => {
      if (outputExceeded) return
      const available = outputLimit - outputSize
      if (chunk.length > available) {
        if (available > 0) output.push(chunk.subarray(0, available))
        outputSize = outputLimit
        outputExceeded = true
        terminate(`verification output exceeded ${outputLimit} bytes`)
        return
      }
      output.push(chunk)
      outputSize += chunk.length
    }
    const onStdout = (chunk: Buffer) => capture(chunk)
    const onError = (error: Error) => {
      terminate(`verification process error: ${verificationError(error)}`)
    }
    const finish = (code: number) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (postKillCompletion) clearTimeout(postKillCompletion)
      child.stdout?.off("data", onStdout)
      child.off("error", onError)
      child.off("close", onClose)
      resolve({
        code,
        output: Buffer.concat(output).toString("utf8"),
        ...(processError === undefined ? {} : { error: processError }),
      })
    }
    const onClose = (code: number | null) => {
      if (termination) {
        void termination.then(
          () => finish(code ?? 1),
          () => finish(code ?? 1),
        )
      } else {
        finish(code ?? 1)
      }
    }

    child.stdout?.on("data", onStdout)
    child.once("error", onError)
    child.once("close", onClose)

    timeout = setTimeout(() => {
      terminate(`verification timed out after ${timeoutMs}ms`)
    }, timeoutMs)
  })
}

/** Drop .apnea/ runtime paths from VCS summaries (artifacts are allowed). */
export function filterAppPaths(summary: string): string {
  return summary
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim()
      if (!t) return false
      // git porcelain: XY path
      if (/^.. /.test(line)) {
        const p = line.slice(3).replace(/^"|"$/g, "")
        return !p.startsWith(".apnea/") && !p.includes("/.apnea/")
      }
      // jj summary often: M path / A path
      const m = t.match(/^[A-Z]+\s+(.+)$/)
      if (m) {
        const p = m[1]!
        return !p.startsWith(".apnea/") && !p.includes("/.apnea/")
      }
      return !t.includes(".apnea/")
    })
    .join("\n")
}

export const VcsLive = Layer.effect(
  Vcs,
  Effect.gen(function* () {
    const fs = yield* FileSystem

    const detect = (root: string): Effect.Effect<VcsBackend | null> =>
      Effect.gen(function* () {
        if (yield* fs.exists(path.join(root, ".jj"))) return "jj"
        if (yield* fs.exists(path.join(root, ".git"))) return "git"
        return null
      })

    const treeFingerprint = (
      root: string,
      vcs: VcsBackend,
    ): Effect.Effect<string> =>
      Effect.sync(() => {
        if (vcs === "jj") {
          const r = run("jj", ["diff", "--summary"], root)
          return filterAppPaths(r.stdout)
        }
        const r = run("git", ["status", "--porcelain"], root)
        return filterAppPaths(r.stdout)
      })

    const isDirty = (root: string, vcs: VcsBackend): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const fp = yield* treeFingerprint(root, vcs)
        return fp.trim().length > 0
      })

    const ensureGitBranch = (
      root: string,
      slug: string,
    ): Effect.Effect<string, VcsError> =>
      Effect.gen(function* () {
        const branch = `apnea/${slug}`
        const cur = yield* Effect.sync(() =>
          run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root),
        )
        if (cur.stdout.trim() === branch) return branch
        const exists = yield* Effect.sync(() =>
          run(
            "git",
            ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
            root,
          ),
        )
        if (exists.ok) {
          const co = yield* Effect.sync(() =>
            run("git", ["checkout", branch], root),
          )
          if (!co.ok) {
            return yield* new VcsError({
              message: `git checkout ${branch}: ${co.stderr}`,
              command: `git checkout ${branch}`,
            })
          }
          return branch
        }
        const cr = yield* Effect.sync(() =>
          run("git", ["checkout", "-b", branch], root),
        )
        if (!cr.ok) {
          return yield* new VcsError({
            message: `git checkout -b ${branch}: ${cr.stderr}`,
            command: `git checkout -b ${branch}`,
          })
        }
        return branch
      })

    const commitPhase = (
      root: string,
      vcs: VcsBackend,
      message: string,
    ): Effect.Effect<string, VcsError> =>
      Effect.gen(function* () {
        if (vcs === "jj") {
          const d = yield* Effect.sync(() =>
            run("jj", ["describe", "-m", message], root),
          )
          if (!d.ok) {
            return yield* new VcsError({
              message: d.stderr || d.stdout,
              command: "jj describe",
            })
          }
          const n = yield* Effect.sync(() => run("jj", ["new"], root))
          if (!n.ok) {
            return yield* new VcsError({
              message: n.stderr || n.stdout,
              command: "jj new",
            })
          }
          return "jj describe + new"
        }
        const add = yield* Effect.sync(() => run("git", ["add", "-A"], root))
        if (!add.ok) {
          return yield* new VcsError({
            message: add.stderr,
            command: "git add -A",
          })
        }
        const c = yield* Effect.sync(() =>
          run("git", ["commit", "-m", message], root),
        )
        if (!c.ok) {
          return yield* new VcsError({
            message: c.stderr || c.stdout,
            command: "git commit",
          })
        }
        return "git commit"
      })

    const setBookmarkAtTerminus = (
      root: string,
      slug: string,
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        const name = `apnea/${slug}`
        const r = run("jj", ["bookmark", "set", name, "-r", "@-"], root)
        if (!r.ok) {
          run("jj", ["bookmark", "create", name, "-r", "@-"], root)
        }
      })

    const runVerify = (
      root: string,
      blocks: readonly VerifyBlock[],
      timeoutMs: number,
    ): Effect.Effect<{ ok: boolean; log: string }> =>
      Effect.promise(async () => {
        const log = new VerificationLog(VERIFY_LOG_LIMIT)
        let temporaryDirectory: string | undefined
        let ok = true
        let operation = "create temporary verification directory"
        try {
          temporaryDirectory = mkdtempSync(path.join(tmpdir(), "apnea-verify-"))
          const wrapper = path.join(temporaryDirectory, "run-block.sh")
          operation = "write verification wrapper"
          writeFileSync(wrapper, VERIFY_WRAPPER_SOURCE, {
            encoding: "utf8",
            mode: 0o600,
          })
          for (const [index, block] of blocks.entries()) {
            const source = normalizeVerifySource(block.source)
            const normalizedBlock = { ...block, source }
            const script = path.join(
              temporaryDirectory,
              `block-${index + 1}.${block.interpreter}`,
            )
            const displayBytes =
              2 + verifyBlockDisplayByteLength(normalizedBlock) + 1
            if (!log.canAppendBytes(displayBytes)) {
              log.addLimitNotice(VERIFY_DISPLAY_LIMIT_NOTICE)
              ok = false
              break
            }
            log.append(`$ ${formatVerifyBlock(normalizedBlock)}\n`)
            operation = `write ${block.interpreter} verification block`
            writeFileSync(script, source, {
              encoding: "utf8",
              mode: 0o600,
            })
            operation = `run ${block.interpreter} verification block`
            const result = await runVerificationProcess(
              wrapper,
              block.interpreter,
              script,
              root,
              timeoutMs,
              Math.max(0, log.remaining - VERIFY_RESULT_RESERVE),
            )
            const output = verificationError(
              result.output.trimEnd(),
              temporaryDirectory,
            )
            if (output && !log.append(`${output}\n`)) {
              log.addLimitNotice(VERIFY_LOG_LIMIT_NOTICE)
              ok = false
              break
            }
            if (!log.append(`exit=${result.code}\n`)) {
              log.addLimitNotice(VERIFY_LOG_LIMIT_NOTICE)
              ok = false
              break
            }
            if (result.error) {
              const error = verificationError(result.error, temporaryDirectory)
              if (!log.append(`${error}\n`)) {
                log.addLimitNotice(VERIFY_LOG_LIMIT_NOTICE)
              }
              ok = false
              break
            }
            if (result.code !== 0) {
              ok = false
              break
            }
            if (index < blocks.length - 1 && !log.append("\n")) {
              log.addLimitNotice(VERIFY_LOG_LIMIT_NOTICE)
              ok = false
              break
            }
          }
        } catch (error) {
          const message = `${operation} failed: ${verificationError(error, temporaryDirectory)}\n`
          if (!log.append(message)) {
            log.addLimitNotice(VERIFY_LOG_LIMIT_NOTICE)
          }
          ok = false
        } finally {
          if (temporaryDirectory) {
            try {
              rmSync(temporaryDirectory, { recursive: true, force: true })
            } catch (error) {
              const message = `clean up temporary verification directory failed: ${verificationError(error, temporaryDirectory)}\n`
              if (!log.append(message)) {
                log.addLimitNotice(VERIFY_LOG_LIMIT_NOTICE)
              }
              ok = false
            }
          }
        }
        return { ok, log: log.toString() }
      })

    return Vcs.of({
      detect,
      isDirty,
      treeFingerprint,
      ensureGitBranch,
      commitPhase,
      setBookmarkAtTerminus,
      runVerify,
    })
  }),
)
