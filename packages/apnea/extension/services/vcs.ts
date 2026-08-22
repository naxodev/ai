import { spawnSync } from "node:child_process"
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
import { createHash, randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Clock, Context, Effect, Layer, Result } from "effect"
import {
  formatVerifyBlock,
  normalizeVerifySource,
  type VerifyBlock,
} from "../domain/verify-commands.ts"
import { VcsError } from "../errors.ts"
import type {
  GitPendingCommit,
  JjPendingCommit,
  PendingCommit,
  VcsBackend,
} from "../domain/types.ts"
import { FileSystem } from "./file-system.ts"
import {
  Process,
  ProcessExitError,
  ProcessOutputError,
  ProcessTimeoutError,
  type ProcessService,
} from "./process.ts"

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
  /**
   * Prepare a commit transaction without moving any ref. Git stages the tree
   * in an isolated index; jj describes `@`. The returned anchor is everything
   * the workflow must persist as `pending_commit` before calling
   * `completeCommit`.
   */
  readonly prepareCommit: (
    root: string,
    vcs: VcsBackend,
    message: string,
  ) => Effect.Effect<PreparedCommit, VcsError>
  /**
   * Complete (or recognize an already-completed) prepared commit exactly
   * once, returning the committed change/commit id. Drift between the
   * persisted anchor and the repository is refused with a typed error.
   */
  readonly completeCommit: (
    root: string,
    vcs: VcsBackend,
    pending: PendingCommit,
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

/**
 * Backend-specific result of `prepareCommit`: the common transaction fields
 * plus the anchor fields of the corresponding `PendingCommit` member.
 */
export type PreparedCommit =
  | Omit<GitPendingCommit, "phase_index" | "no_remaining_phases" | "verify_log">
  | Omit<JjPendingCommit, "phase_index" | "no_remaining_phases" | "verify_log">

/** The trailer line appended to every prepared commit message body. */
export const TRANSACTION_TRAILER_PREFIX = "Apnea-Transaction:"

export function withTransactionTrailer(message: string, id: string): string {
  return `${message}\n\n${TRANSACTION_TRAILER_PREFIX} ${id}`
}

/** Strip the trailer for comparing a retry's `message` param. */
export function withoutTransactionTrailer(message: string): string {
  const index = message.lastIndexOf(`\n\n${TRANSACTION_TRAILER_PREFIX} `)
  return index === -1 ? message : message.slice(0, index)
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  )
}

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

/**
 * Runner for repository-mutating VCS commands. Unlike the synchronous
 * `VcsCommandRunner` (bounded reads over spawnSync), mutations go through
 * the #107 Process service so they carry a hard timeout, kill their process
 * tree on cancellation, and surface typed failures.
 */
export type VcsMutationRunner = (
  command: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
) => Effect.Effect<CommandResult, VcsError>

/** Upper bound for a single mutating VCS command (commit-tree, describe, …). */
export const MUTATING_VCS_TIMEOUT_MS = 120_000

export function processMutationRunner(
  processService: ProcessService,
): VcsMutationRunner {
  return (command, args, cwd, env) =>
    processService
      .run({
        command,
        args,
        cwd,
        env: env === undefined ? undefined : { ...process.env, ...env },
        timeoutMs: MUTATING_VCS_TIMEOUT_MS,
      })
      .pipe(
        Effect.map((result) => ({
          ok: result.exitCode === 0,
          stdout: result.stdout,
          stderr: result.stderr,
          code: result.exitCode,
        })),
        Effect.mapError(
          (error): VcsError =>
            new VcsError({
              message: `${command} failed: ${error.message}`,
              command: `${command} ${args[0] ?? ""}`.trim(),
            }),
        ),
      )
}

/** Test seam: lift a synchronous runner into the mutation-runner shape. */
export function syncMutationRunner(
  runCommand: VcsCommandRunner,
): VcsMutationRunner {
  return (command, args, cwd, env) =>
    Effect.sync(() => runCommand(command, args, cwd, env))
}

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

/**
 * Fingerprint the non-`.apnea` diff of a single jj revision. Used for the
 * pending-commit content anchor: computed over `@` at preparation and
 * recomputed over the same change at completion to detect drift.
 */
export function jjRevisionFingerprintWithCommand(
  root: string,
  revision: string,
  runCommand: VcsCommandRunner = run,
): Effect.Effect<string, VcsError> {
  return Effect.gen(function* () {
    const result = yield* requireCommand(
      runCommand(
        "jj",
        [
          "diff",
          "--git",
          "--color=never",
          "-r",
          revision,
          "--",
          JJ_NOT_APNEA_ICASE,
        ],
        root,
      ),
      `jj diff --git -r ${revision}`,
    )
    return digest([result.stdout])
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

type VerificationProcessResult = {
  code: number
  output: string
  error?: string
}

function runVerificationProcess(
  processService: ProcessService,
  wrapper: string,
  interpreter: VerifyBlock["interpreter"],
  script: string,
  cwd: string,
  timeoutMs: number,
  outputLimit: number,
  reportedTimeoutMs = timeoutMs,
): Effect.Effect<VerificationProcessResult> {
  return Effect.gen(function* () {
    const result = yield* Effect.result(
      processService.run({
        command: "sh",
        args: [wrapper, interpreter, script],
        cwd,
        timeoutMs,
        outputLimitBytes: Math.max(1, outputLimit),
      }),
    )
    if (Result.isSuccess(result)) {
      return { code: result.success.exitCode, output: result.success.stdout }
    }
    const error = result.failure
    if (error instanceof ProcessExitError) {
      return {
        code: error.exitCode,
        output: `${error.stdout}${error.stderr}`,
      }
    }
    if (error instanceof ProcessTimeoutError) {
      return {
        code: 1,
        output: `${error.stdout}${error.stderr}`,
        error: `verification timed out after ${reportedTimeoutMs}ms`,
      }
    }
    if (error instanceof ProcessOutputError) {
      return {
        code: 1,
        output: `${error.stdout}${error.stderr}`,
        error: `verification output exceeded ${outputLimit} bytes`,
      }
    }
    return {
      code: 1,
      output: "stdout" in error ? `${error.stdout}${error.stderr}` : "",
      error: `verification process error: ${verificationError(error)}`,
    }
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

/**
 * Current branch via `symbolic-ref -q`. Returns null for detached HEAD —
 * with `-q`, Git signals that case as exit 1 with empty stdout, which
 * `requireCommand` would otherwise swallow into a generic failure.
 */
function gitCurrentBranchWithCommand(
  root: string,
  runCommand: VcsCommandRunner,
): Effect.Effect<string | null, VcsError> {
  return Effect.sync(() =>
    runCommand("git", ["symbolic-ref", "-q", "HEAD"], root),
  ).pipe(
    Effect.flatMap((result) => {
      if (result.ok) return Effect.succeed(result.stdout.trim())
      if (result.code === 1 && result.stdout.trim() === "") {
        return Effect.succeed(null)
      }
      return Effect.fail(
        new VcsError({
          message:
            result.stderr || result.stdout || "git symbolic-ref -q HEAD failed",
          command: "git symbolic-ref -q HEAD",
        }),
      )
    }),
  )
}

/**
 * Prepare a Git commit transaction: stage everything except case-folded
 * `.apnea` aliases in an isolated index, persist the resulting tree id, and
 * append the `Apnea-Transaction:` trailer to the message body. No ref moves
 * and no real-index mutation — safe to retry after a crash before completion.
 */
export function gitPrepareWithCommand(
  root: string,
  message: string,
  runCommand: VcsCommandRunner = run,
): Effect.Effect<PreparedCommit, VcsError> {
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
    const branch = yield* gitCurrentBranchWithCommand(root, runCommand)
    if (branch === null) {
      return yield* new VcsError({
        message: "refusing commit: detached HEAD has no branch to update",
        command: "git symbolic-ref -q HEAD",
      })
    }
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
      const id = randomUUID()
      return {
        backend: "git" as const,
        id,
        message: withTransactionTrailer(message, id),
        branch,
        parent_commit: head.stdout.trim(),
        tree_id: tree.stdout.trim(),
      }
    } finally {
      yield* Effect.try({
        try: () => rmSync(temporary, { recursive: true, force: true }),
        catch: (error) =>
          new VcsError({
            message: `could not remove isolated Git index: ${error instanceof Error ? error.message : String(error)}`,
          }),
      })
    }
  })
}

type GitHeadInfo = {
  hash: string
  tree: string
  firstParent: string | null
  body: string
}

function gitHeadInfoWithCommand(
  root: string,
  runCommand: VcsCommandRunner,
): Effect.Effect<GitHeadInfo, VcsError> {
  return Effect.gen(function* () {
    const shown = yield* requireCommand(
      runCommand(
        "git",
        ["show", "-s", "--format=%H%n%T%n%P%n%B", "HEAD"],
        root,
      ),
      "git show -s HEAD",
    )
    const lines = shown.stdout.split("\n")
    const parents = (lines[2] ?? "").trim()
    return {
      hash: (lines[0] ?? "").trim(),
      tree: (lines[1] ?? "").trim(),
      firstParent: parents === "" ? null : parents.split(" ")[0]!,
      body: lines.slice(3).join("\n"),
    }
  })
}

/**
 * Complete (or recognize) a prepared Git transaction exactly once:
 *
 * - HEAD still at the recorded parent → validate branch and tree, then create
 *   the commit (`commit-tree` + CAS `update-ref`, signing preserved).
 * - HEAD is a commit whose message carries this transaction's
 *   `Apnea-Transaction:` marker and whose parent and tree match the anchor →
 *   treat as completed and return its id.
 * - Anything else → refuse, naming the drift.
 */
export function gitCompleteWithCommand(
  root: string,
  pending: GitPendingCommit,
  runCommand: VcsCommandRunner = run,
  runMutation: VcsMutationRunner = syncMutationRunner(run),
): Effect.Effect<string, VcsError> {
  return Effect.gen(function* () {
    if (!isUuid(pending.id)) {
      return yield* new VcsError({
        message: `refusing commit: pending_commit.id is not a uuid: ${pending.id}`,
      })
    }
    const currentBranch = yield* gitCurrentBranchWithCommand(root, runCommand)
    if (currentBranch !== pending.branch) {
      return yield* new VcsError({
        message: `refusing commit: branch drifted since preparation (expected ${pending.branch}, found ${currentBranch ?? "(detached HEAD)"})`,
        command: "git symbolic-ref -q HEAD",
      })
    }
    const head = yield* gitHeadInfoWithCommand(root, runCommand)

    if (head.hash !== pending.parent_commit) {
      // Either the crash hit after the commit landed (recognize it), or the
      // repository drifted for unrelated reasons (refuse). The marker alone
      // is not proof — parent and tree must match the prepared anchor too.
      if (!head.body.includes(`${TRANSACTION_TRAILER_PREFIX} ${pending.id}`)) {
        return yield* new VcsError({
          message: `refusing commit: HEAD moved since preparation without this transaction's marker (expected ${pending.parent_commit}, found ${head.hash})`,
        })
      }
      if (head.firstParent !== pending.parent_commit) {
        return yield* new VcsError({
          message: `refusing commit: marked transaction commit has unexpected parent (expected ${pending.parent_commit}, found ${head.firstParent ?? "(root)"})`,
        })
      }
      if (head.tree !== pending.tree_id) {
        return yield* new VcsError({
          message: `refusing commit: marked transaction commit has unexpected tree (expected ${pending.tree_id}, found ${head.tree})`,
        })
      }
      return head.hash
    }

    // Create case: HEAD sits at the recorded parent. The tree was validated
    // at preparation time and tree objects are immutable, so only its
    // continued existence needs checking.
    yield* requireCommand(
      runCommand("git", ["cat-file", "-e", `${pending.tree_id}^{tree}`], root),
      `git cat-file -e ${pending.tree_id}^{tree}`,
    )
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
      pending.tree_id,
      "-p",
      pending.parent_commit,
      "-m",
      pending.message,
      ...(signing.ok && signing.stdout.trim() === "true" ? ["-S"] : []),
    ]
    const committed = yield* requireCommand(
      yield* runMutation("git", commitArgs, root),
      "git commit-tree",
    )

    // The real index must match the validated tree before the branch can move.
    // Accepted tradeoff: if the CAS update-ref below loses a race, the index
    // briefly describes an unreachable commit until the next Git command
    // re-reads HEAD. Rewinding it here would add another mutating window to
    // recover from; staleness is safe because the index is rebuilt from the
    // branch tip on the next checkout/reset.
    yield* requireCommand(
      yield* runMutation("git", ["read-tree", committed.stdout.trim()], root),
      "git read-tree committed tree",
    )
    yield* requireCommand(
      yield* runMutation(
        "git",
        [
          "update-ref",
          pending.branch,
          committed.stdout.trim(),
          pending.parent_commit,
        ],
        root,
      ),
      "git update-ref (compare-and-swap)",
    )
    return committed.stdout.trim()
  })
}

export function runVerifyWithProcess(
  root: string,
  blocks: readonly VerifyBlock[],
  timeoutMs: number,
  processService: ProcessService,
): Effect.Effect<{ ok: boolean; log: string }> {
  return Effect.gen(function* () {
    const log = new VerificationLog(VERIFY_LOG_LIMIT)
    const startedAt = yield* Clock.currentTimeNanos
    const deadline =
      startedAt + BigInt(Math.max(0, Math.floor(timeoutMs))) * 1_000_000n
    let temporaryDirectory: string | undefined
    let ok = true
    let operation = "create temporary verification directory"

    const remainingMs = (): Effect.Effect<number> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeNanos
        return Number((deadline - now) / 1_000_000n)
      })

    const work = Effect.gen(function* () {
      temporaryDirectory = yield* Effect.try({
        try: () => mkdtempSync(path.join(tmpdir(), "apnea-verify-")),
        catch: (error) => error,
      })
      const wrapper = path.join(temporaryDirectory, "run-block.sh")
      operation = "write verification wrapper"
      yield* Effect.try({
        try: () =>
          writeFileSync(wrapper, VERIFY_WRAPPER_SOURCE, {
            encoding: "utf8",
            mode: 0o600,
          }),
        catch: (error) => error,
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
        yield* Effect.try({
          try: () =>
            writeFileSync(script, source, {
              encoding: "utf8",
              mode: 0o600,
            }),
          catch: (error) => error,
        })
        const remaining = yield* remainingMs()
        if (remaining <= 0) {
          log.append(`verification timed out after ${timeoutMs}ms\n`)
          ok = false
          break
        }
        operation = `run ${block.interpreter} verification block`
        const result = yield* runVerificationProcess(
          processService,
          wrapper,
          block.interpreter,
          script,
          root,
          remaining,
          Math.max(0, log.remaining - VERIFY_RESULT_RESERVE),
          timeoutMs,
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
          if (!log.append(`${error}\n`))
            log.addLimitNotice(VERIFY_LOG_LIMIT_NOTICE)
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
      return { ok, log: log.toString() }
    }).pipe(
      Effect.catch((error) => {
        const message = `${operation} failed: ${verificationError(error, temporaryDirectory)}\n`
        if (!log.append(message)) log.addLimitNotice(VERIFY_LOG_LIMIT_NOTICE)
        ok = false
        return Effect.succeed({ ok, log: log.toString() })
      }),
    )

    return yield* Effect.ensuring(
      work,
      Effect.sync(() => {
        if (temporaryDirectory) {
          rmSync(temporaryDirectory, { recursive: true, force: true })
        }
      }).pipe(Effect.ignore),
    )
  })
}

/** Sentinel fingerprint of an empty (content-free) diff. */
export const EMPTY_JJ_DIFF_FINGERPRINT = ""

const JJ_DRIFT_RECOVERY_GUIDANCE =
  "Inspect `.apnea/state.json` (pending_commit) and `jj log -r @- --no-graph -T 'description ++ \"\\n\" ++ change_id'`. " +
  "Recovery requires clearing pending_commit manually; Apnea never clears it automatically because the prepared commit may have already landed, and clearing would let the same phase commit twice."

/** Change id of a jj revision, empty when the revision is absent. */
function jjChangeIdWithCommand(
  root: string,
  revision: string,
  runCommand: VcsCommandRunner,
): CommandResult {
  return runCommand(
    "jj",
    ["log", "-r", revision, "--no-graph", "-T", "change_id"],
    root,
  )
}

/**
 * Prepare a jj commit transaction: describe `@` with the message (trailer
 * included) and persist its change id plus the non-`.apnea` content
 * fingerprint. Describing is idempotent and moves no ref: a crash before
 * `pending_commit` is saved simply describes again on retry.
 *
 * A change whose diff is only `.apnea` is refused here, before anything is
 * persisted or described: completing such a transaction would evict every
 * diff from the terminus during recovery, leaving an empty change that jj
 * abandons — wedging the transaction permanently.
 */
export function jjPrepareWithCommand(
  root: string,
  message: string,
  runCommand: VcsCommandRunner = run,
  runMutation: VcsMutationRunner = syncMutationRunner(run),
): Effect.Effect<PreparedCommit, VcsError> {
  return Effect.gen(function* () {
    yield* rejectCaseFoldedApneaAlias(root)
    const trackedRuntime = yield* requireCommand(
      runCommand(
        "jj",
        ["file", "list", "-r", "@-", "--", JJ_APNEA_ICASE],
        root,
      ),
      `jj file list -r @- -- ${JJ_APNEA_ICASE}`,
    )
    if (trackedRuntime.stdout.trim()) {
      return yield* new VcsError({
        message:
          "refusing commit: .apnea exists in the committed parent snapshot",
        command: `jj file list -r @- -- ${JJ_APNEA_ICASE}`,
      })
    }
    const at = yield* requireCommand(
      jjChangeIdWithCommand(root, "@", runCommand),
      "jj log -r @",
    )
    const changeId = at.stdout.trim()
    if (!changeId) {
      return yield* new VcsError({
        message: "refusing commit: could not resolve the @ change id",
        command: "jj log -r @",
      })
    }
    // Fingerprint the non-.apnea diff of @ before describing; completion
    // recomputes it over the same revision to detect content drift.
    const fingerprint = yield* jjRevisionFingerprintWithCommand(
      root,
      changeId,
      runCommand,
    )
    if (fingerprint === EMPTY_JJ_DIFF_FINGERPRINT) {
      return yield* new VcsError({
        message:
          `refusing commit: @ (${changeId}) has no non-.apnea changes to commit; ` +
          "a transaction anchored here would abandon the change during recovery. Commit or stash the working copy first.",
        command: "jj diff -r @",
      })
    }
    const id = randomUUID()
    const trailerMessage = withTransactionTrailer(message, id)
    yield* requireCommand(
      yield* runMutation("jj", ["describe", "-m", trailerMessage], root),
      "jj describe",
    )
    return {
      backend: "jj" as const,
      id,
      message: trailerMessage,
      change_id: changeId,
      content_fingerprint: fingerprint,
    }
  })
}

/**
 * Move any `.apnea` diffs the described terminus still carries back into
 * the working copy. `jj describe` snapshots all of `@`, so untracked
 * `.apnea` changes ride along; eviction keeps the commit's complement
 * invariant. Idempotent: a no-op once the diffs are already in `@`.
 */
function evictApneaFromTerminus(
  root: string,
  changeId: string,
  runCommand: VcsCommandRunner,
  runMutation: VcsMutationRunner,
): Effect.Effect<void, VcsError> {
  return Effect.gen(function* () {
    const present = yield* requireCommand(
      runCommand(
        "jj",
        ["file", "list", "-r", changeId, "--", JJ_APNEA_ICASE],
        root,
      ),
      `jj file list -r ${changeId} -- ${JJ_APNEA_ICASE}`,
    )
    if (!present.stdout.trim()) return
    yield* requireCommand(
      yield* runMutation(
        "jj",
        ["squash", "--from", changeId, "--into", "@", "--", JJ_APNEA_ICASE],
        root,
      ),
      `jj squash --from ${changeId} --into @ -- ${JJ_APNEA_ICASE}`,
    )
  })
}

/**
 * Complete (or recognize) a prepared jj transaction exactly once:
 *
 * - Target is still `@` → crash hit between describe and `jj new`; verify
 *   marker and fingerprint, advance with `jj new`, evict `.apnea`.
 * - Target is `@-` → completion ran before the crash; verify marker and
 *   fingerprint, finish an interrupted `.apnea` eviction.
 * - Anything else, or drifted content → refuse with typed guidance.
 */
export function jjCompleteWithCommand(
  root: string,
  pending: JjPendingCommit,
  runCommand: VcsCommandRunner = run,
  runMutation: VcsMutationRunner = syncMutationRunner(run),
): Effect.Effect<string, VcsError> {
  return Effect.gen(function* () {
    if (!isUuid(pending.id)) {
      return yield* new VcsError({
        message: `refusing commit: pending_commit.id is not a uuid: ${pending.id}`,
      })
    }
    const at = (yield* requireCommand(
      jjChangeIdWithCommand(root, "@", runCommand),
      "jj log -r @",
    )).stdout.trim()
    const atMinus = (yield* requireCommand(
      jjChangeIdWithCommand(root, "@-", runCommand),
      "jj log -r @-",
    )).stdout.trim()

    const marker = `${TRANSACTION_TRAILER_PREFIX} ${pending.id}`
    const descriptionOf = (
      rev: string,
    ): Effect.Effect<string | null, VcsError> =>
      Effect.gen(function* () {
        const r = yield* requireCommand(
          runCommand(
            "jj",
            ["log", "-r", rev, "--no-graph", "-T", "description"],
            root,
          ),
          `jj log -r ${rev} description`,
        )
        return r.stdout.includes(marker) ? r.stdout : null
      })

    // Case 1: target already sits at @- — completion ran before the crash.
    if (atMinus === pending.change_id) {
      const description = yield* descriptionOf("@-")
      if (description === null) {
        return yield* new VcsError({
          message: `refusing commit: @- is ${pending.change_id} but its description lacks this transaction's marker`,
        })
      }
      const fingerprint = yield* jjRevisionFingerprintWithCommand(
        root,
        pending.change_id,
        runCommand,
      )
      if (fingerprint !== pending.content_fingerprint) {
        return yield* new VcsError({
          message: `refusing commit: prepared jj change ${pending.change_id} drifted from its recorded content fingerprint. ${JJ_DRIFT_RECOVERY_GUIDANCE}`,
        })
      }
      if (fingerprint === EMPTY_JJ_DIFF_FINGERPRINT) {
        return yield* new VcsError({
          message: `refusing commit: prepared jj change ${pending.change_id} has no non-.apnea content; completing would abandon it and wedge the transaction. ${JJ_DRIFT_RECOVERY_GUIDANCE}`,
        })
      }
      yield* evictApneaFromTerminus(
        root,
        pending.change_id,
        runCommand,
        runMutation,
      )
      return pending.change_id
    }

    // Case 2: target is still @ — crash hit between describe and `jj new`.
    if (at === pending.change_id) {
      const description = yield* descriptionOf("@")
      if (description === null) {
        return yield* new VcsError({
          message: `refusing commit: @ is ${pending.change_id} but its description lacks this transaction's marker`,
        })
      }
      const fingerprint = yield* jjRevisionFingerprintWithCommand(
        root,
        pending.change_id,
        runCommand,
      )
      if (fingerprint !== pending.content_fingerprint) {
        return yield* new VcsError({
          message: `refusing commit: prepared jj change ${pending.change_id} drifted from its recorded content fingerprint. ${JJ_DRIFT_RECOVERY_GUIDANCE}`,
        })
      }
      if (fingerprint === EMPTY_JJ_DIFF_FINGERPRINT) {
        return yield* new VcsError({
          message: `refusing commit: prepared jj change ${pending.change_id} has no non-.apnea content; completing would abandon it and wedge the transaction. ${JJ_DRIFT_RECOVERY_GUIDANCE}`,
        })
      }
      yield* requireCommand(
        yield* runMutation("jj", ["new", pending.change_id], root),
        `jj new ${pending.change_id}`,
      )
      yield* evictApneaFromTerminus(
        root,
        pending.change_id,
        runCommand,
        runMutation,
      )
      return pending.change_id
    }

    return yield* new VcsError({
      message: `refusing commit: prepared jj change ${pending.change_id} is neither @ nor @- (repository moved on since preparation). ${JJ_DRIFT_RECOVERY_GUIDANCE}`,
      command: "jj log -r @-",
    })
  })
}

export const VcsLive = Layer.effect(
  Vcs,
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const processService = yield* Process

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

    const prepareCommit = (
      root: string,
      vcs: VcsBackend,
      message: string,
    ): Effect.Effect<PreparedCommit, VcsError> => {
      const mutate = processMutationRunner(processService)
      return vcs === "jj"
        ? jjPrepareWithCommand(root, message, run, mutate)
        : gitPrepareWithCommand(root, message, run)
    }

    const completeCommit = (
      root: string,
      vcs: VcsBackend,
      pending: PendingCommit,
    ): Effect.Effect<string, VcsError> => {
      const mutate = processMutationRunner(processService)
      if (vcs === "jj") {
        if (pending.backend !== "jj") {
          return Effect.fail(
            new VcsError({
              message: `pending_commit anchor is ${pending.backend} but this run uses jj`,
            }),
          )
        }
        return jjCompleteWithCommand(root, pending, run, mutate)
      }
      if (pending.backend !== "git") {
        return Effect.fail(
          new VcsError({
            message: `pending_commit anchor is ${pending.backend} but this run uses git`,
          }),
        )
      }
      return gitCompleteWithCommand(root, pending, run, mutate)
    }

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
      runVerifyWithProcess(root, blocks, timeoutMs, processService)

    return Vcs.of({
      detect,
      isDirty,
      treeFingerprint,
      ensureGitBranch,
      prepareCommit,
      completeCommit,
      setBookmarkAtTerminus,
      runVerify,
    })
  }),
)
