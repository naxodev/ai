import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createHash } from "node:crypto"
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
  readonly isDirty: (
    root: string,
    vcs: VcsBackend,
  ) => Effect.Effect<boolean, VcsError>
  readonly treeFingerprint: (
    root: string,
    vcs: VcsBackend,
  ) => Effect.Effect<string, VcsError>
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
  ) => Effect.Effect<void, VcsError>
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
  env?: NodeJS.ProcessEnv,
): { ok: boolean; stdout: string; stderr: string; code: number } {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: env === undefined ? undefined : { ...process.env, ...env },
  })
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? "").toString(),
    stderr: (r.stderr ?? r.error?.message ?? "").toString(),
    code: r.status ?? 1,
  }
}

function runRaw(
  cmd: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): { ok: boolean; stdout: Buffer; stderr: string; code: number } {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: null,
    maxBuffer: 10 * 1024 * 1024,
    env: env === undefined ? undefined : { ...process.env, ...env },
  })
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: (result.stderr ?? result.error?.message ?? "").toString("utf8"),
    code: result.status ?? 1,
  }
}

type CommandResult = ReturnType<typeof run>
export type VcsCommandRunner = typeof run
export type VcsRawCommandRunner = typeof runRaw

const APNEA_ICASE_PATHSPEC = ":(icase).apnea"
const APNEA_ICASE_EXCLUDES = [
  ":(exclude,icase).apnea",
  ":(exclude,icase).apnea/**",
]
const JJ_APNEA_ICASE = "root-prefix-glob-i:.apnea"
const JJ_NOT_APNEA_ICASE = `~${JJ_APNEA_ICASE}`
export const UNTRACKED_FINGERPRINT_MAX_BYTES = 256 * 1024 * 1024
export const UNTRACKED_FINGERPRINT_TIMEOUT_MS = 10_000

function requireCommand(
  result: CommandResult,
  command: string,
): Effect.Effect<CommandResult, VcsError> {
  return result.ok
    ? Effect.succeed(result)
    : Effect.fail(
        new VcsError({
          message: `${command} failed: ${result.stderr || result.stdout}`,
          command,
        }),
      )
}

function requireRawCommand(
  result: ReturnType<VcsRawCommandRunner>,
  command: string,
): Effect.Effect<ReturnType<VcsRawCommandRunner>, VcsError> {
  return result.ok
    ? Effect.succeed(result)
    : Effect.fail(
        new VcsError({
          message: `${command} failed: ${result.stderr}`,
          command,
        }),
      )
}

function splitNullBuffers(value: Buffer): Buffer[] {
  const parts: Buffer[] = []
  let start = 0
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== 0) continue
    if (index > start) parts.push(value.subarray(start, index))
    start = index + 1
  }
  if (start < value.length) parts.push(value.subarray(start))
  return parts
}

function digest(parts: readonly (string | Buffer)[]): string {
  if (parts.every((part) => part.length === 0)) return ""
  const hash = createHash("sha256")
  for (const part of parts) hash.update(part)
  return hash.digest("hex")
}

function rejectCaseFoldedApneaAlias(
  root: string,
): Effect.Effect<void, VcsError> {
  return Effect.try({
    try: () => {
      const alias = readdirSync(root).find(
        (name) => name.toLowerCase() === ".apnea" && name !== ".apnea",
      )
      if (alias !== undefined) {
        throw new VcsError({
          message: `refusing case-insensitive .apnea alias at repository root: ${alias}`,
        })
      }
    },
    catch: (error) =>
      error instanceof VcsError
        ? error
        : new VcsError({
            message: `could not inspect repository root for .apnea aliases: ${error instanceof Error ? error.message : String(error)}`,
          }),
  })
}

type FingerprintLimits = {
  readonly maxBytes: number
  readonly timeoutMs: number
}

export function fingerprintUntrackedFiles(
  root: string,
  files: readonly (string | Buffer)[],
  limits: FingerprintLimits = {
    maxBytes: UNTRACKED_FINGERPRINT_MAX_BYTES,
    timeoutMs: UNTRACKED_FINGERPRINT_TIMEOUT_MS,
  },
): Effect.Effect<string, VcsError> {
  return Effect.try({
    try: () => {
      if (files.length === 0) return ""
      if (
        !Number.isFinite(limits.maxBytes) ||
        limits.maxBytes < 0 ||
        !Number.isFinite(limits.timeoutMs) ||
        limits.timeoutMs < 0
      ) {
        throw new VcsError({ message: "invalid untracked fingerprint limits" })
      }
      const startedAt = Date.now()
      const hash = createHash("sha256")
      const buffer = Buffer.allocUnsafe(64 * 1024)
      let totalBytes = 0

      const account = (bytes: number) => {
        totalBytes += bytes
        if (totalBytes > limits.maxBytes) {
          throw new VcsError({
            message: `untracked fingerprint byte limit exceeded (${limits.maxBytes} bytes)`,
          })
        }
        if (Date.now() - startedAt > limits.timeoutMs) {
          throw new VcsError({
            message: `untracked fingerprint timed out after ${limits.timeoutMs}ms`,
          })
        }
      }

      for (const file of files) {
        const rawFile = Buffer.isBuffer(file) ? file : Buffer.from(file)
        const components = splitNullBuffers(
          Buffer.from(rawFile.map((byte) => (byte === 0x2f ? 0 : byte))),
        )
        if (
          rawFile.length === 0 ||
          rawFile[0] === 0x2f ||
          components.some(
            (component) =>
              component.length === 2 &&
              component[0] === 0x2e &&
              component[1] === 0x2e,
          )
        ) {
          throw new VcsError({
            message: `invalid untracked path from VCS: ${rawFile.toString("hex")}`,
          })
        }
        const absolute = Buffer.concat([
          Buffer.from(`${path.resolve(root)}${path.sep}`),
          rawFile,
        ])
        const display = rawFile.toString("hex")
        const before = lstatSync(absolute)
        hash.update(rawFile)
        hash.update("\0")
        if (before.isSymbolicLink()) {
          const target = readlinkSync(absolute, { encoding: "buffer" })
          const after = lstatSync(absolute)
          if (
            !after.isSymbolicLink() ||
            after.dev !== before.dev ||
            after.ino !== before.ino ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs
          ) {
            throw new VcsError({
              message: `untracked symlink changed while fingerprinting (hex path): ${display}`,
            })
          }
          account(target.length)
          hash.update("symlink\0")
          hash.update(target)
          hash.update("\0")
          continue
        }
        if (!before.isFile()) {
          throw new VcsError({
            message: `untracked fingerprints accept only regular files or symlinks (hex path): ${display}`,
          })
        }

        let descriptor: number | undefined
        try {
          descriptor = openSync(
            absolute,
            process.platform === "win32"
              ? "r"
              : fsConstants.O_RDONLY |
                  fsConstants.O_NOFOLLOW |
                  fsConstants.O_NONBLOCK,
          )
          const opened = fstatSync(descriptor)
          if (
            !opened.isFile() ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino
          ) {
            throw new VcsError({
              message: `untracked file changed while fingerprinting (hex path): ${display}`,
            })
          }
          if (opened.size > limits.maxBytes - totalBytes) {
            throw new VcsError({
              message: `untracked fingerprint byte limit exceeded (${limits.maxBytes} bytes)`,
            })
          }
          hash.update("file\0")
          for (;;) {
            const bytes = readSync(descriptor, buffer, 0, buffer.length, null)
            if (bytes === 0) break
            account(bytes)
            hash.update(buffer.subarray(0, bytes))
          }
          const after = fstatSync(descriptor)
          if (
            after.size !== opened.size ||
            after.mtimeMs !== opened.mtimeMs ||
            after.ctimeMs !== opened.ctimeMs
          ) {
            throw new VcsError({
              message: `untracked file changed while fingerprinting (hex path): ${display}`,
            })
          }
          hash.update("\0")
        } finally {
          if (descriptor !== undefined) closeSync(descriptor)
        }
      }
      return hash.digest("hex")
    },
    catch: (error) =>
      error instanceof VcsError
        ? error
        : new VcsError({
            message: `could not fingerprint untracked files: ${error instanceof Error ? error.message : String(error)}`,
          }),
  })
}

export function treeFingerprintWithCommand(
  root: string,
  vcs: VcsBackend,
  runCommand: VcsCommandRunner,
  runRawCommand: VcsRawCommandRunner = runRaw,
): Effect.Effect<string, VcsError> {
  return Effect.gen(function* () {
    if (vcs === "jj") {
      const command = `jj diff --git --color=never -- ${JJ_NOT_APNEA_ICASE}`
      const result = yield* requireCommand(
        runCommand(
          "jj",
          ["diff", "--git", "--color=never", "--", JJ_NOT_APNEA_ICASE],
          root,
        ),
        command,
      )
      return digest([result.stdout])
    }
    const pathspec = ["--", ".", ...APNEA_ICASE_EXCLUDES]
    const staged = yield* requireCommand(
      runCommand(
        "git",
        ["diff", "--binary", "--no-ext-diff", "--cached", ...pathspec],
        root,
      ),
      "git diff --cached",
    )
    const unstaged = yield* requireCommand(
      runCommand(
        "git",
        ["diff", "--binary", "--no-ext-diff", ...pathspec],
        root,
      ),
      "git diff",
    )
    const untracked = yield* requireRawCommand(
      runRawCommand(
        "git",
        ["ls-files", "--others", "--exclude-standard", "-z", ...pathspec],
        root,
      ),
      "git ls-files --others",
    )
    const untrackedFingerprint = yield* fingerprintUntrackedFiles(
      root,
      splitNullBuffers(untracked.stdout),
    )
    if (
      staged.stdout.length === 0 &&
      unstaged.stdout.length === 0 &&
      untrackedFingerprint.length === 0
    ) {
      return ""
    }
    return digest([
      "staged\0",
      staged.stdout,
      "\0unstaged\0",
      unstaged.stdout,
      "\0untracked\0",
      untrackedFingerprint,
    ])
  })
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
        const p = line.slice(3).replace(/^"|"$/g, "").toLowerCase()
        return !p.startsWith(".apnea/") && !p.includes("/.apnea/")
      }
      // jj summary often: M path / A path
      const m = t.match(/^[A-Z]+\s+(.+)$/)
      if (m) {
        const p = m[1]!.toLowerCase()
        return !p.startsWith(".apnea/") && !p.includes("/.apnea/")
      }
      return !t.toLowerCase().includes(".apnea/")
    })
    .join("\n")
}

export function gitCommitPhaseWithCommand(
  root: string,
  message: string,
  runCommand: VcsCommandRunner = run,
): Effect.Effect<string, VcsError> {
  return Effect.gen(function* () {
    yield* rejectCaseFoldedApneaAlias(root)
    const trackedRuntime = yield* requireCommand(
      runCommand("git", ["ls-files", "-z", "--", APNEA_ICASE_PATHSPEC], root),
      `git ls-files -- ${APNEA_ICASE_PATHSPEC}`,
    )
    const stagedRuntime = yield* requireCommand(
      runCommand(
        "git",
        ["diff", "--cached", "--name-only", "-z", "--", APNEA_ICASE_PATHSPEC],
        root,
      ),
      `git diff --cached --name-only -- ${APNEA_ICASE_PATHSPEC}`,
    )
    if (trackedRuntime.stdout.length > 0 || stagedRuntime.stdout.length > 0) {
      return yield* new VcsError({
        message: "refusing commit: .apnea is already tracked or staged",
        command: "git ls-files/diff --cached with :(icase).apnea pathspec",
      })
    }

    const head = yield* requireCommand(
      runCommand("git", ["rev-parse", "--verify", "HEAD"], root),
      "git rev-parse --verify HEAD",
    )
    const branch = yield* requireCommand(
      runCommand("git", ["symbolic-ref", "-q", "HEAD"], root),
      "git symbolic-ref -q HEAD",
    )
    const temporary = yield* Effect.try({
      try: () => mkdtempSync(path.join(tmpdir(), "apnea-index-")),
      catch: (error) =>
        new VcsError({
          message: `could not create isolated Git index: ${error instanceof Error ? error.message : String(error)}`,
        }),
    })
    const index = path.join(temporary, "index")
    const indexEnv = { GIT_INDEX_FILE: index }
    try {
      yield* requireCommand(
        runCommand("git", ["read-tree", head.stdout.trim()], root, indexEnv),
        "git read-tree HEAD",
      )
      yield* requireCommand(
        runCommand(
          "git",
          ["add", "-A", "--", ".", ...APNEA_ICASE_EXCLUDES],
          root,
          indexEnv,
        ),
        "git add with isolated index",
      )
      yield* rejectCaseFoldedApneaAlias(root)
      const isolatedRuntime = yield* requireCommand(
        runCommand(
          "git",
          ["ls-files", "-z", "--", APNEA_ICASE_PATHSPEC],
          root,
          indexEnv,
        ),
        "git ls-files isolated index",
      )
      if (isolatedRuntime.stdout.length > 0) {
        return yield* new VcsError({
          message: "refusing commit: isolated tree contains .apnea",
        })
      }
      const tree = yield* requireCommand(
        runCommand("git", ["write-tree"], root, indexEnv),
        "git write-tree",
      )
      const treeRuntime = yield* requireCommand(
        runCommand(
          "git",
          ["ls-tree", "-r", "--name-only", "-z", tree.stdout.trim()],
          root,
        ),
        "git ls-tree isolated tree",
      )
      if (
        treeRuntime.stdout
          .split("\0")
          .filter(Boolean)
          .some((file) => file.split("/", 1)[0]!.toLowerCase() === ".apnea")
      ) {
        return yield* new VcsError({
          message: "refusing commit: written tree contains .apnea",
        })
      }

      const signing = runCommand(
        "git",
        ["config", "--bool", "commit.gpgsign"],
        root,
      )
      if (!signing.ok && signing.code !== 1) {
        return yield* new VcsError({
          message: signing.stderr || signing.stdout,
          command: "git config --bool commit.gpgsign",
        })
      }
      const commitArgs = [
        "commit-tree",
        tree.stdout.trim(),
        "-p",
        head.stdout.trim(),
        "-m",
        message,
        ...(signing.ok && signing.stdout.trim() === "true" ? ["-S"] : []),
      ]
      const committed = yield* requireCommand(
        runCommand("git", commitArgs, root),
        "git commit-tree",
      )
      const currentBranch = yield* requireCommand(
        runCommand("git", ["symbolic-ref", "-q", "HEAD"], root),
        "git symbolic-ref -q HEAD",
      )
      if (currentBranch.stdout.trim() !== branch.stdout.trim()) {
        return yield* new VcsError({
          message: "current Git branch changed before commit update",
          command: "git symbolic-ref -q HEAD",
        })
      }

      // The real index must match the validated tree before the branch can move.
      yield* requireCommand(
        runCommand("git", ["read-tree", committed.stdout.trim()], root),
        "git read-tree committed tree",
      )
      yield* requireCommand(
        runCommand(
          "git",
          [
            "update-ref",
            branch.stdout.trim(),
            committed.stdout.trim(),
            head.stdout.trim(),
          ],
          root,
        ),
        "git update-ref (compare-and-swap)",
      )
    } finally {
      yield* Effect.try({
        try: () => rmSync(temporary, { recursive: true, force: true }),
        catch: (error) =>
          new VcsError({
            message: `could not remove isolated Git index: ${error instanceof Error ? error.message : String(error)}`,
          }),
      })
    }
    return "git commit-tree + update-ref"
  })
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
    ): Effect.Effect<string, VcsError> =>
      Effect.gen(function* () {
        yield* rejectCaseFoldedApneaAlias(root)
        return yield* treeFingerprintWithCommand(root, vcs, run)
      })

    const isDirty = (
      root: string,
      vcs: VcsBackend,
    ): Effect.Effect<boolean, VcsError> =>
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
        yield* rejectCaseFoldedApneaAlias(root)
        if (vcs === "jj") {
          const trackedRuntime = yield* requireCommand(
            run("jj", ["file", "list", "-r", "@-", "--", JJ_APNEA_ICASE], root),
            `jj file list -r @- -- ${JJ_APNEA_ICASE}`,
          )
          if (trackedRuntime.stdout.trim()) {
            return yield* new VcsError({
              message:
                "refusing commit: .apnea exists in the committed parent snapshot",
              command: `jj file list -r @- -- ${JJ_APNEA_ICASE}`,
            })
          }
          const committed = run(
            "jj",
            ["commit", "-m", message, "--", JJ_NOT_APNEA_ICASE],
            root,
          )
          if (!committed.ok) {
            return yield* new VcsError({
              message: committed.stderr || committed.stdout,
              command: `jj commit -- ${JJ_NOT_APNEA_ICASE}`,
            })
          }
          return "jj commit"
        }
        return yield* gitCommitPhaseWithCommand(root, message)
      })

    const setBookmarkAtTerminus = (
      root: string,
      slug: string,
    ): Effect.Effect<void, VcsError> =>
      Effect.gen(function* () {
        const name = `apnea/${slug}`
        const r = run("jj", ["bookmark", "set", name, "-r", "@-"], root)
        if (!r.ok) {
          const fallback = run(
            "jj",
            ["bookmark", "create", name, "-r", "@-"],
            root,
          )
          if (!fallback.ok) {
            return yield* new VcsError({
              message:
                fallback.stderr || fallback.stdout || r.stderr || r.stdout,
              command: `jj bookmark set ${name} -r @-`,
            })
          }
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
