import { afterEach, describe, expect, test } from "bun:test"
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Effect, Exit, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { VcsError } from "../errors.ts"
import {
  extractVerifyBlocks,
  formatVerifyBlock,
  type VerifyBlock,
} from "../domain/verify-commands.ts"
import { makeFakeFileSystem } from "../test/fake-file-system.ts"
import { itEffect } from "../test/it-effect.ts"
import {
  Vcs,
  VcsLive,
  EMPTY_JJ_DIFF_FINGERPRINT,
  filterAppPaths,
  fingerprintUntrackedFiles,
  gitCompleteWithCommand,
  gitPrepareWithCommand,
  jjCompleteWithCommand,
  jjPrepareWithCommand,
  runVerifyWithProcess,
  treeFingerprintWithCommand,
  utf8BytesAfterAppend,
  syncMutationRunner,
  verifyBlockDisplayByteLength,
  type PreparedCommit,
} from "./vcs.ts"
import type { GitPendingCommit, JjPendingCommit } from "../domain/types.ts"
import { FileSystemLive } from "./file-system.ts"
import {
  ProcessLive,
  ProcessTimeoutError,
  type ProcessService,
} from "./process.ts"

function withFake(initial: Record<string, string> = {}) {
  const fake = makeFakeFileSystem(initial)
  // Also mark directories that exist as empty keys via mkdir semantics —
  // exists returns true for dirs. Seed .jj/.git as empty file markers.
  const layer = Layer.provideMerge(
    VcsLive,
    Layer.merge(fake.layer, ProcessLive),
  )
  return { fake, layer }
}

const projectRoots: string[] = []

afterEach(() => {
  for (const root of projectRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "apnea-vcs-test-"))
  projectRoots.push(root)
  return root
}

function command(root: string, bin: string, args: string[]): string {
  const result = spawnSync(bin, args, { cwd: root, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`${bin} ${args.join(" ")}: ${result.stderr}`)
  }
  return result.stdout
}

function commandResult(
  root: string,
  bin: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): { ok: boolean; stdout: string; stderr: string; code: number } {
  const result = spawnSync(bin, args, {
    cwd: root,
    encoding: "utf8",
    env: env === undefined ? undefined : { ...process.env, ...env },
  })
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
    code: result.status ?? 1,
  }
}

function realVcs<A>(effect: Effect.Effect<A, VcsError | never, Vcs>) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.provide(VcsLive, Layer.merge(FileSystemLive, ProcessLive)),
      ),
    ),
  )
}

/** Same as realVcs but keeps the Effect so failures can be flipped/inspected. */
function realVcsEffect<A>(effect: Effect.Effect<A, VcsError, Vcs>) {
  return Effect.provide(
    effect,
    Layer.provide(VcsLive, Layer.merge(FileSystemLive, ProcessLive)),
  )
}

/** Turn a prepared anchor into a full pending-commit record for tests. */
function asGitPending(prepared: PreparedCommit): GitPendingCommit {
  if (prepared.backend !== "git") throw new Error("expected git anchor")
  return {
    ...prepared,
    phase_index: 1,
    no_remaining_phases: false,
    verify_log: ".apnea/verify.log",
  }
}

function jjPendingOf(prepared: PreparedCommit): JjPendingCommit {
  if (prepared.backend !== "jj") throw new Error("expected jj anchor")
  return {
    ...prepared,
    phase_index: 1,
    no_remaining_phases: false,
    verify_log: ".apnea/verify.log",
  }
}

function gitPrepare(root: string, message = "test commit") {
  return realVcs(gitPrepareWithCommand(root, message))
}

function runVerify(
  root: string,
  blocks: readonly VerifyBlock[],
  timeoutMs = 10_000,
) {
  const { layer } = withFake()
  return Effect.runPromise(
    Effect.gen(function* () {
      const vcs = yield* Vcs
      return yield* vcs.runVerify(root, blocks, timeoutMs)
    }).pipe(Effect.provide(layer)),
  )
}

async function processExited(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

describe("Vcs.detect (fake FileSystem)", () => {
  itEffect(".jj → jj", () => {
    const { layer } = withFake({ "/proj/.jj": "" })
    return Effect.gen(function* () {
      const vcs = yield* Vcs
      expect(yield* vcs.detect("/proj")).toBe("jj")
    }).pipe(Effect.provide(layer))
  })

  itEffect(".git → git", () => {
    const { layer } = withFake({ "/proj/.git": "" })
    return Effect.gen(function* () {
      const vcs = yield* Vcs
      expect(yield* vcs.detect("/proj")).toBe("git")
    }).pipe(Effect.provide(layer))
  })

  itEffect("neither → null", () => {
    const { layer } = withFake()
    return Effect.gen(function* () {
      const vcs = yield* Vcs
      expect(yield* vcs.detect("/proj")).toBeNull()
    }).pipe(Effect.provide(layer))
  })

  itEffect(".jj wins over .git", () => {
    const { layer } = withFake({
      "/proj/.jj": "",
      "/proj/.git": "",
    })
    return Effect.gen(function* () {
      const vcs = yield* Vcs
      expect(yield* vcs.detect("/proj")).toBe("jj")
    }).pipe(Effect.provide(layer))
  })
})

describe("filterAppPaths", () => {
  test("drops git porcelain .apnea/ lines; keeps src", () => {
    const input = [
      " M .apnea/state.json",
      " M src/x.ts",
      ' M ".apnea/artifacts/x"',
      "",
    ].join("\n")
    const out = filterAppPaths(input)
    expect(out).toBe(" M src/x.ts")
  })

  test("drops jj summary .apnea/ lines", () => {
    const input = ["M .apnea/state.json", "M src/y.ts", "A foo.ts"].join("\n")
    const out = filterAppPaths(input)
    expect(out.split("\n")).toEqual(["M src/y.ts", "A foo.ts"])
  })

  test("drops blank lines", () => {
    expect(filterAppPaths("\n\n  \n")).toBe("")
  })
})

describe("Vcs repository safety", () => {
  itEffect(
    "command seam fingerprints diff bytes rather than path summaries",
    () => {
      let diff = "diff --git a/file.txt b/file.txt\n-old\n+first\n"
      return Effect.gen(function* () {
        const first = yield* treeFingerprintWithCommand(
          "/project",
          "jj",
          () => ({
            ok: true,
            stdout: diff,
            stderr: "",
            code: 0,
          }),
        )
        diff = "diff --git a/file.txt b/file.txt\n-old\n+other\n"
        const second = yield* treeFingerprintWithCommand(
          "/project",
          "jj",
          () => ({
            ok: true,
            stdout: diff,
            stderr: "",
            code: 0,
          }),
        )
        expect(second).not.toBe(first)
      })
    },
  )

  test("git fingerprint hashes content and ignores .apnea", async () => {
    const root = makeProject()
    command(root, "git", ["init", "-q"])
    command(root, "git", ["config", "user.email", "apnea@example.test"])
    command(root, "git", ["config", "user.name", "Apnea Test"])
    writeFileSync(path.join(root, "tracked.txt"), "base\n")
    command(root, "git", ["add", "tracked.txt"])
    command(root, "git", ["commit", "-qm", "base"])

    writeFileSync(path.join(root, "tracked.txt"), "first\n")
    const first = await realVcs(
      Effect.gen(function* () {
        return yield* (yield* Vcs).treeFingerprint(root, "git")
      }),
    )
    writeFileSync(path.join(root, "tracked.txt"), "other\n")
    const second = await realVcs(
      Effect.gen(function* () {
        return yield* (yield* Vcs).treeFingerprint(root, "git")
      }),
    )
    expect(second).not.toBe(first)

    mkdirSync(path.join(root, ".apnea"))
    writeFileSync(path.join(root, ".apnea", "state.json"), "one")
    const beforeRuntimeChange = second
    writeFileSync(path.join(root, ".apnea", "state.json"), "two")
    expect(
      await realVcs(
        Effect.gen(function* () {
          return yield* (yield* Vcs).treeFingerprint(root, "git")
        }),
      ),
    ).toBe(beforeRuntimeChange)

    writeFileSync(path.join(root, "untracked.txt"), "one")
    const untrackedOne = await realVcs(
      Effect.gen(function* () {
        return yield* (yield* Vcs).treeFingerprint(root, "git")
      }),
    )
    writeFileSync(path.join(root, "untracked.txt"), "two")
    expect(
      await realVcs(
        Effect.gen(function* () {
          return yield* (yield* Vcs).treeFingerprint(root, "git")
        }),
      ),
    ).not.toBe(untrackedOne)
  })

  test("rejects case-folded .apnea aliases before Git fingerprint or commit", async () => {
    const root = makeProject()
    command(root, "git", ["init", "-q"])
    command(root, "git", ["config", "user.email", "apnea@example.test"])
    command(root, "git", ["config", "user.name", "Apnea Test"])
    writeFileSync(path.join(root, "tracked.txt"), "base\n")
    command(root, "git", ["add", "tracked.txt"])
    command(root, "git", ["commit", "-qm", "base"])
    mkdirSync(path.join(root, ".APNEA"))
    writeFileSync(path.join(root, ".APNEA", "state.json"), "runtime\n")

    await expect(
      realVcs(
        Effect.gen(function* () {
          yield* (yield* Vcs).treeFingerprint(root, "git")
        }),
      ),
    ).rejects.toThrow("case-insensitive")
    await expect(
      realVcs(
        Effect.gen(function* () {
          yield* (yield* Vcs).prepareCommit(root, "git", "unsafe alias")
        }),
      ),
    ).rejects.toThrow("case-insensitive")
  })

  test.skipIf(process.platform === "win32")(
    "hashes large files incrementally and rejects FIFOs without blocking",
    async () => {
      const root = makeProject()
      const large = path.join(root, "large.bin")
      const descriptor = openSync(large, "w")
      const chunk = Buffer.alloc(64 * 1024, 0x61)
      try {
        for (let index = 0; index < 192; index++) writeSync(descriptor, chunk)
      } finally {
        closeSync(descriptor)
      }
      const first = await Effect.runPromise(
        fingerprintUntrackedFiles(root, ["large.bin"]),
      )
      const changed = openSync(large, "r+")
      try {
        writeSync(changed, Buffer.from("b"), 0, 1, 11 * 1024 * 1024)
      } finally {
        closeSync(changed)
      }
      expect(
        await Effect.runPromise(fingerprintUntrackedFiles(root, ["large.bin"])),
      ).not.toBe(first)

      command(root, "mkfifo", ["special.fifo"])
      await expect(
        Effect.runPromise(fingerprintUntrackedFiles(root, ["special.fifo"])),
      ).rejects.toThrow("regular files or symlinks")
    },
  )

  test("bounds aggregate untracked bytes", async () => {
    const root = makeProject()
    writeFileSync(path.join(root, "too-large.txt"), "12345")
    await expect(
      Effect.runPromise(
        fingerprintUntrackedFiles(root, ["too-large.txt"], {
          maxBytes: 4,
          timeoutMs: 10_000,
        }),
      ),
    ).rejects.toThrow("byte limit")
  })

  test("tree fingerprint returns VcsError when the command fails", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* (yield* Vcs).treeFingerprint(
          path.join(makeProject(), "missing"),
          "git",
        )
      }).pipe(
        Effect.provide(
          Layer.provide(VcsLive, Layer.merge(FileSystemLive, ProcessLive)),
        ),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Exit.findErrorOption(exit)
      expect(Option.isSome(error)).toBe(true)
      if (Option.isSome(error)) expect(error.value).toBeInstanceOf(VcsError)
    }
  })

  test("git commit excludes untracked .apnea and refuses tracked .apnea", async () => {
    const root = makeProject()
    command(root, "git", ["init", "-q"])
    command(root, "git", ["config", "user.email", "apnea@example.test"])
    command(root, "git", ["config", "user.name", "Apnea Test"])
    writeFileSync(path.join(root, "tracked.txt"), "base\n")
    command(root, "git", ["add", "tracked.txt"])
    command(root, "git", ["commit", "-qm", "base"])
    mkdirSync(path.join(root, ".apnea"))
    writeFileSync(path.join(root, ".apnea", "state.json"), "runtime\n")
    writeFileSync(path.join(root, "tracked.txt"), "changed\n")
    const hook = path.join(root, ".git", "hooks", "pre-commit")
    writeFileSync(
      hook,
      "#!/bin/sh\nmkdir -p .apnea\nprintf hook > .apnea/from-hook\ngit add -f .apnea/from-hook\nprintf ran > hook-ran\n",
      { mode: 0o700 },
    )

    const prepared = await realVcs(
      Effect.gen(function* () {
        return yield* (yield* Vcs).prepareCommit(root, "git", "safe commit")
      }),
    )
    await realVcs(
      Effect.gen(function* () {
        yield* (yield* Vcs).completeCommit(root, "git", asGitPending(prepared))
      }),
    )
    expect(prepared.message).toContain("Apnea-Transaction: ")
    expect(command(root, "git", ["ls-files", ".apnea"])).toBe("")
    expect(command(root, "git", ["log", "-1", "--format=%B"])).toContain(
      `Apnea-Transaction: ${prepared.id}`,
    )
    expect(command(root, "git", ["write-tree"]).trim()).toBe(
      command(root, "git", ["rev-parse", "HEAD^{tree}"]).trim(),
    )
    expect(existsSync(path.join(root, "hook-ran"))).toBe(false)
    expect(
      command(root, "git", ["show", "--name-only", "--format=", "HEAD"]),
    ).not.toContain(".apnea")

    command(root, "git", ["add", "-f", ".apnea/state.json"])
    await expect(
      realVcs(
        Effect.gen(function* () {
          yield* (yield* Vcs).prepareCommit(root, "git", "unsafe commit")
        }),
      ),
    ).rejects.toThrow(".apnea")

    command(root, "git", ["commit", "-qm", "track runtime"])
    rmSync(path.join(root, ".apnea", "state.json"))
    command(root, "git", ["add", "-u", "--", ".apnea"])
    await expect(
      realVcs(
        Effect.gen(function* () {
          yield* (yield* Vcs).prepareCommit(root, "git", "unsafe deletion")
        }),
      ),
    ).rejects.toThrow(".apnea")
  })

  test("jj leaves fresh unignored .apnea changes in the new working copy", async () => {
    const available = spawnSync("jj", ["--version"], { encoding: "utf8" })
    if (available.status !== 0) return
    const root = makeProject()
    command(root, "jj", ["git", "init", "--colocate"])
    mkdirSync(path.join(root, ".apnea"))
    writeFileSync(path.join(root, ".apnea", "state.json"), "runtime\n")
    writeFileSync(path.join(root, "tracked.txt"), "change\n")

    const first = await realVcs(
      Effect.gen(function* () {
        return yield* (yield* Vcs).treeFingerprint(root, "jj")
      }),
    )
    writeFileSync(path.join(root, "tracked.txt"), "different content\n")
    const second = await realVcs(
      Effect.gen(function* () {
        return yield* (yield* Vcs).treeFingerprint(root, "jj")
      }),
    )
    expect(second).not.toBe(first)
    writeFileSync(path.join(root, ".apnea", "state.json"), "changed runtime\n")
    expect(
      await realVcs(
        Effect.gen(function* () {
          return yield* (yield* Vcs).treeFingerprint(root, "jj")
        }),
      ),
    ).toBe(second)

    const preparedJj = await realVcs(
      Effect.gen(function* () {
        return yield* (yield* Vcs).prepareCommit(
          root,
          "jj",
          "safe source commit",
        )
      }),
    )
    await realVcs(
      Effect.gen(function* () {
        yield* (yield* Vcs).completeCommit(root, "jj", jjPendingOf(preparedJj))
      }),
    )
    expect(
      command(root, "jj", [
        "log",
        "-r",
        "@-",
        "--no-graph",
        "-T",
        "description",
      ]).trim(),
    ).toContain("safe source commit")
    expect(
      command(root, "jj", [
        "log",
        "-r",
        "@-",
        "--no-graph",
        "-T",
        "description",
      ]),
    ).toContain(`Apnea-Transaction: ${preparedJj.id}`)
    expect(command(root, "jj", ["diff", "--name-only"])).toContain(
      ".apnea/state.json",
    )
  })

  test("jj rejects a clean tracked .apnea and case aliases", async () => {
    const available = spawnSync("jj", ["--version"], { encoding: "utf8" })
    if (available.status !== 0) return
    const root = makeProject()
    command(root, "jj", ["git", "init", "--colocate"])
    mkdirSync(path.join(root, ".apnea"))
    writeFileSync(path.join(root, ".apnea", "state.json"), "tracked\n")
    writeFileSync(path.join(root, "tracked.txt"), "base\n")
    command(root, "jj", ["commit", "-m", "unsafe seed"])
    writeFileSync(path.join(root, "tracked.txt"), "changed\n")
    await expect(
      realVcs(
        Effect.gen(function* () {
          yield* (yield* Vcs).prepareCommit(root, "jj", "must refuse")
        }),
      ),
    ).rejects.toThrow(".apnea")

    renameSync(path.join(root, ".apnea"), path.join(root, ".ApNeA"))
    await expect(
      realVcs(
        Effect.gen(function* () {
          yield* (yield* Vcs).treeFingerprint(root, "jj")
        }),
      ),
    ).rejects.toThrow("case-insensitive")
  })

  test("jj commits only the case-insensitive complement of .apnea", async () => {
    const available = spawnSync("jj", ["--version"], { encoding: "utf8" })
    if (available.status !== 0) return
    const root = makeProject()
    command(root, "jj", ["git", "init", "--colocate"])
    writeFileSync(path.join(root, ".gitignore"), ".apnea/\n")
    writeFileSync(path.join(root, "tracked.txt"), "base\n")
    command(root, "jj", ["commit", "-m", "base"])
    mkdirSync(path.join(root, ".apnea"))
    writeFileSync(path.join(root, ".apnea", "state.json"), "runtime\n")
    writeFileSync(path.join(root, "tracked.txt"), "changed\n")

    const preparedJj2 = await realVcs(
      Effect.gen(function* () {
        return yield* (yield* Vcs).prepareCommit(root, "jj", "safe jj commit")
      }),
    )
    await realVcs(
      Effect.gen(function* () {
        yield* (yield* Vcs).completeCommit(root, "jj", jjPendingOf(preparedJj2))
      }),
    )

    const committed = command(root, "jj", ["diff", "-r", "@-", "--name-only"])
    expect(committed).toContain("tracked.txt")
    expect(committed.toLowerCase()).not.toContain(".apnea")
    expect(readFileSync(path.join(root, ".apnea", "state.json"), "utf8")).toBe(
      "runtime\n",
    )
  })

  test("setBookmarkAtTerminus surfaces a typed command failure", async () => {
    const root = makeProject()
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* (yield* Vcs).setBookmarkAtTerminus(root, "demo")
      }).pipe(
        Effect.provide(
          Layer.provide(VcsLive, Layer.merge(FileSystemLive, ProcessLive)),
        ),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Exit.findErrorOption(exit)
      expect(Option.isSome(error)).toBe(true)
      if (Option.isSome(error)) expect(error.value).toBeInstanceOf(VcsError)
    }
  })

  test.skipIf(process.platform !== "linux")(
    "preserves distinct invalid-byte filenames and symlink targets",
    async () => {
      const root = makeProject()
      command(root, "git", ["init", "-q"])
      command(root, "git", ["config", "user.email", "apnea@example.test"])
      command(root, "git", ["config", "user.name", "Apnea Test"])
      writeFileSync(path.join(root, "base.txt"), "base\n")
      command(root, "git", ["add", "base.txt"])
      command(root, "git", ["commit", "-qm", "base"])

      const rawName = Buffer.concat([
        Buffer.from(`${root}${path.sep}raw-`),
        Buffer.from([0x80]),
      ])
      writeFileSync(rawName, "one")
      const first = await realVcs(
        Effect.gen(function* () {
          return yield* (yield* Vcs).treeFingerprint(root, "git")
        }),
      )
      writeFileSync(rawName, "two")
      const second = await realVcs(
        Effect.gen(function* () {
          return yield* (yield* Vcs).treeFingerprint(root, "git")
        }),
      )
      expect(second).not.toBe(first)

      const link = Buffer.from(`${root}${path.sep}raw-link`)
      symlinkSync(Buffer.from([0x80]), link)
      const targetOne = await realVcs(
        Effect.gen(function* () {
          return yield* (yield* Vcs).treeFingerprint(root, "git")
        }),
      )
      rmSync(link)
      symlinkSync(Buffer.from([0x81]), link)
      expect(
        await realVcs(
          Effect.gen(function* () {
            return yield* (yield* Vcs).treeFingerprint(root, "git")
          }),
        ),
      ).not.toBe(targetOne)
    },
  )

  test("real index failure leaves the Git branch unchanged", async () => {
    const root = makeProject()
    command(root, "git", ["init", "-q"])
    command(root, "git", ["config", "user.email", "apnea@example.test"])
    command(root, "git", ["config", "user.name", "Apnea Test"])
    writeFileSync(path.join(root, "tracked.txt"), "base\n")
    command(root, "git", ["add", "tracked.txt"])
    command(root, "git", ["commit", "-qm", "base"])
    writeFileSync(path.join(root, "tracked.txt"), "changed\n")
    const before = command(root, "git", ["rev-parse", "HEAD"]).trim()

    const injected = (
      bin: string,
      args: string[],
      cwd: string,
      env?: NodeJS.ProcessEnv,
    ) => {
      if (args[0] === "read-tree" && env === undefined) {
        return { ok: false, stdout: "", stderr: "injected", code: 1 }
      }
      return commandResult(cwd, bin, args, env)
    }
    const preparedInjected = await Effect.runPromise(
      gitPrepareWithCommand(root, "must not move", injected),
    )
    await expect(
      Effect.runPromise(
        gitCompleteWithCommand(
          root,
          asGitPending(preparedInjected),
          injected,
          syncMutationRunner(injected),
        ),
      ),
    ).rejects.toThrow("injected")
    expect(command(root, "git", ["rev-parse", "HEAD"]).trim()).toBe(before)
  })

  test("git preparation maps detached HEAD to a friendly typed refusal", async () => {
    const root = makeProject()
    command(root, "git", ["init", "-q"])
    command(root, "git", ["config", "user.email", "apnea@example.test"])
    command(root, "git", ["config", "user.name", "Apnea Test"])
    writeFileSync(path.join(root, "tracked.txt"), "base\n")
    command(root, "git", ["add", "tracked.txt"])
    command(root, "git", ["commit", "-qm", "base"])
    // `symbolic-ref -q` exits 1 with empty stdout here — the generic
    // requireCommand failure must not mask the real problem.
    command(root, "git", ["checkout", "--detach", "-q", "HEAD"])
    writeFileSync(path.join(root, "tracked.txt"), "changed\n")

    await expect(
      realVcs(
        Effect.gen(function* () {
          yield* (yield* Vcs).prepareCommit(root, "git", "no branch")
        }),
      ),
    ).rejects.toThrow(/detached HEAD/)
  })

  test("git completion refuses a detached HEAD as anchor drift", async () => {
    const root = makeProject()
    command(root, "git", ["init", "-q"])
    command(root, "git", ["config", "user.email", "apnea@example.test"])
    command(root, "git", ["config", "user.name", "Apnea Test"])
    writeFileSync(path.join(root, "tracked.txt"), "base\n")
    command(root, "git", ["add", "tracked.txt"])
    command(root, "git", ["commit", "-qm", "base"])
    writeFileSync(path.join(root, "tracked.txt"), "changed\n")
    const prepared = await gitPrepare(root, "detached completion")

    command(root, "git", ["checkout", "--detach", "-q", "HEAD"])
    await expect(
      realVcs(
        Effect.gen(function* () {
          yield* (yield* Vcs).completeCommit(
            root,
            "git",
            asGitPending(prepared),
          )
        }),
      ),
    ).rejects.toThrow(/detached HEAD/)
  })

  test("jj prepare refuses a working copy whose only diffs are .apnea", async () => {
    const available = spawnSync("jj", ["--version"], { encoding: "utf8" })
    if (available.status !== 0) return
    const root = makeProject()
    command(root, "jj", ["git", "init", "--colocate"])
    writeFileSync(path.join(root, "tracked.txt"), "base\n")
    command(root, "jj", ["commit", "-m", "base"])
    mkdirSync(path.join(root, ".apnea"))
    writeFileSync(path.join(root, ".apnea", "state.json"), "runtime\n")

    const error = await Effect.runPromise(
      Effect.flip(realVcsEffect(jjPrepareWithCommand(root, "empty content"))),
    )
    expect(error).toBeInstanceOf(VcsError)
    expect(error.message).toContain("no non-.apnea changes")
  })

  test("jj completion refuses an empty-content terminus before it can be abandoned", async () => {
    const available = spawnSync("jj", ["--version"], { encoding: "utf8" })
    if (available.status !== 0) return
    const root = makeProject()
    command(root, "jj", ["git", "init", "--colocate"])
    writeFileSync(path.join(root, "tracked.txt"), "base\n")
    command(root, "jj", ["commit", "-m", "base"])
    mkdirSync(path.join(root, ".apnea"))
    writeFileSync(path.join(root, ".apnea", "state.json"), "runtime\n")

    // Hand-craft the state prepare now refuses to produce: a described
    // change with an empty non-.apnea fingerprint, as an older version
    // could have persisted.
    const changeId = command(root, "jj", [
      "log",
      "-r",
      "@",
      "--no-graph",
      "-T",
      "change_id",
    ]).trim()
    const id = "3d6f4b2c-15e9-6e33-1c4b-7a8f0c9d1e23"
    command(root, "jj", [
      "describe",
      "-m",
      `orphaned transaction\n\nApnea-Transaction: ${id}`,
    ])

    const error = await Effect.runPromise(
      Effect.flip(
        jjCompleteWithCommand(root, {
          backend: "jj",
          id,
          phase_index: 1,
          message: `orphaned transaction\n\nApnea-Transaction: ${id}`,
          no_remaining_phases: false,
          verify_log: ".apnea/verify.log",
          change_id: changeId,
          content_fingerprint: EMPTY_JJ_DIFF_FINGERPRINT,
        }),
      ),
    )
    expect(error).toBeInstanceOf(VcsError)
    expect(error.message).toContain("wedge the transaction")
    // The target is still @ — nothing advanced.
    expect(changeId).toBe(
      command(root, "jj", [
        "log",
        "-r",
        "@",
        "--no-graph",
        "-T",
        "change_id",
      ]).trim(),
    )
  })

  test("git completion is idempotent: a crash after the commit is recognized, not doubled", async () => {
    const root = makeProject()
    command(root, "git", ["init", "-q"])
    command(root, "git", ["config", "user.email", "apnea@example.test"])
    command(root, "git", ["config", "user.name", "Apnea Test"])
    writeFileSync(path.join(root, "tracked.txt"), "base\n")
    command(root, "git", ["add", "tracked.txt"])
    command(root, "git", ["commit", "-qm", "base"])
    writeFileSync(path.join(root, "tracked.txt"), "changed\n")

    const prepared = await realVcs(
      Effect.gen(function* () {
        return yield* (yield* Vcs).prepareCommit(root, "git", "recovered")
      }),
    )
    const pending = asGitPending(prepared)

    const first = await realVcs(
      Effect.gen(function* () {
        return yield* (yield* Vcs).completeCommit(root, "git", pending)
      }),
    )
    expect(first).toMatch(/^[0-9a-f]{40}$/)

    // Simulate the crash: state was never advanced; completion runs again.
    const second = await realVcs(
      Effect.gen(function* () {
        return yield* (yield* Vcs).completeCommit(root, "git", pending)
      }),
    )
    expect(second).toBe(first)
    expect(command(root, "git", ["rev-list", "--count", "HEAD"]).trim()).toBe(
      "2",
    )
    expect(command(root, "git", ["log", "-1", "--format=%B"])).toContain(
      `Apnea-Transaction: ${pending.id}`,
    )
  })

  test("git completion refuses branch drift after preparation", async () => {
    const root = makeProject()
    command(root, "git", ["init", "-q"])
    command(root, "git", ["config", "user.email", "apnea@example.test"])
    command(root, "git", ["config", "user.name", "Apnea Test"])
    writeFileSync(path.join(root, "tracked.txt"), "base\n")
    command(root, "git", ["add", "tracked.txt"])
    command(root, "git", ["commit", "-qm", "base"])

    const prepared = await gitPrepare(root, "drifted")
    const pending = asGitPending(prepared)
    // Unrelated commit lands on the branch between prepare and complete.
    writeFileSync(path.join(root, "other.txt"), "unrelated\n")
    command(root, "git", ["add", "other.txt"])
    command(root, "git", ["commit", "-qm", "unrelated"])

    await expect(
      realVcs(
        Effect.gen(function* () {
          yield* (yield* Vcs).completeCommit(root, "git", pending)
        }),
      ),
    ).rejects.toThrow(/HEAD moved since preparation|branch drifted/)

    // A tampered marker with mismatched parent/tree also refuses.
    writeFileSync(path.join(root, "tracked.txt"), "more\n")
    command(root, "git", ["add", "tracked.txt"])
    command(root, "git", [
      "commit",
      "-qm",
      `forged\n\nApnea-Transaction: ${pending.id}`,
    ])
    await expect(
      realVcs(
        Effect.gen(function* () {
          yield* (yield* Vcs).completeCommit(root, "git", pending)
        }),
      ),
    ).rejects.toThrow("unexpected parent")
  })

  test.skipIf(process.platform === "win32")(
    "jj recovery: crash after describe advances once; drift refuses",
    async () => {
      const available = spawnSync("jj", ["--version"], { encoding: "utf8" })
      if (available.status !== 0) return
      const root = makeProject()
      command(root, "jj", ["git", "init", "--colocate"])
      writeFileSync(path.join(root, "tracked.txt"), "base\n")
      command(root, "jj", ["commit", "-m", "base"])
      mkdirSync(path.join(root, ".apnea"))
      writeFileSync(path.join(root, ".apnea", "state.json"), "runtime\n")
      writeFileSync(path.join(root, "tracked.txt"), "change\n")

      // Crash window 1: describe happened (prepare), nothing else.
      const prepared = await realVcs(
        Effect.gen(function* () {
          return yield* (yield* Vcs).prepareCommit(root, "jj", "recover me")
        }),
      )
      expect(
        command(root, "jj", [
          "log",
          "-r",
          "@",
          "--no-graph",
          "-T",
          "description",
        ]),
      ).toContain(`Apnea-Transaction: ${prepared.id}`)

      const pending = jjPendingOf(prepared)

      // Fingerprint drift refuses while the target is still @.
      writeFileSync(path.join(root, "tracked.txt"), "tampered\n")
      await expect(
        realVcs(
          Effect.gen(function* () {
            yield* (yield* Vcs).completeCommit(root, "jj", pending)
          }),
        ),
      ).rejects.toThrow("fingerprint")

      // Restoring the prepared content lets completion proceed exactly once.
      writeFileSync(path.join(root, "tracked.txt"), "change\n")
      const first = await realVcs(
        Effect.gen(function* () {
          return yield* (yield* Vcs).completeCommit(root, "jj", pending)
        }),
      )
      expect(first).toBe(pending.change_id)

      // Crash window 2: everything done, only recognition remains.
      const second = await realVcs(
        Effect.gen(function* () {
          return yield* (yield* Vcs).completeCommit(root, "jj", pending)
        }),
      )
      expect(second).toBe(first)

      // Exactly one new change beyond base; .apnea stayed out of it.
      const committed = command(root, "jj", ["diff", "-r", "@-", "--name-only"])
      expect(committed).toContain("tracked.txt")
      expect(committed.toLowerCase()).not.toContain(".apnea")
      const workingCopy = command(root, "jj", ["diff", "--name-only"])
      expect(workingCopy).toContain(".apnea/state.json")

      // Once the repository moves past the anchored change, the drift
      // refusal names the exact recovery surface (.apnea/state.json →
      // pending_commit) and why it is never cleared automatically.
      writeFileSync(path.join(root, "tracked.txt"), "more\n")
      command(root, "jj", ["commit", "-m", "further work"])
      await expect(
        realVcs(
          Effect.gen(function* () {
            yield* (yield* Vcs).completeCommit(root, "jj", pending)
          }),
        ),
      ).rejects.toThrow(
        /neither @ nor @-[\s\S]*pending_commit[\s\S]*never clears it automatically/,
      )
    },
  )
})

describe("utf8BytesAfterAppend", () => {
  test("enforces one UTF-8 byte budget across every log category", () => {
    const parts = [
      "$ bash -e [verification block]\n",
      "| printf 'résultat\\n'\n",
      "résultat\n",
      "exit=0\n",
      "verification timed out after 200ms\n",
      "\n",
    ]
    const exactLimit = parts.reduce(
      (bytes, part) => utf8BytesAfterAppend(bytes, Infinity, part)!,
      0,
    )
    let used = 0
    for (const part of parts) {
      used = utf8BytesAfterAppend(used, exactLimit, part)!
    }

    expect(used).toBe(exactLimit)
    expect(utf8BytesAfterAppend(used, exactLimit, "later block")).toBeNull()
  })

  test("preflights the exact formatted display size without building the display", () => {
    const block = {
      interpreter: "bash" as const,
      source: "printf 'résultat\\n'\necho done\n",
    }

    expect(verifyBlockDisplayByteLength(block)).toBe(
      Buffer.byteLength(formatVerifyBlock(block)),
    )
  })
})

describe("Vcs.runVerify", () => {
  test("uses one total deadline across every verification block", async () => {
    const root = makeProject()
    const timeouts: number[] = []
    const processService: ProcessService = {
      run: (options) => {
        timeouts.push(options.timeoutMs)
        if (timeouts.length === 1) {
          return Effect.sleep(600).pipe(
            Effect.as({ exitCode: 0, stdout: "first\n", stderr: "" }),
          )
        }
        return Effect.sleep(options.timeoutMs).pipe(
          Effect.andThen(
            Effect.fail(
              new ProcessTimeoutError(
                options.command,
                options.timeoutMs,
                "",
                "",
              ),
            ),
          ),
        )
      },
    }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          runVerifyWithProcess(
            root,
            [
              { interpreter: "sh", source: "true" },
              { interpreter: "sh", source: "true" },
            ],
            1_000,
            processService,
          ),
        )
        yield* TestClock.adjust(1_000)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(timeouts).toEqual([1_000, 400])
    expect(result.ok).toBe(false)
  })

  test("runs a complete Bash script with functions, locals, heredocs, and an EXIT trap", async () => {
    const root = makeProject()
    const result = await runVerify(root, [
      {
        interpreter: "bash",
        source: `write_result() {
  local value="from local"
  cat <<EOF > result.txt
$value
EOF
}
trap 'printf "from trap\\n" >> result.txt' EXIT
write_result
printf 'child output\\n'`,
      },
    ])

    expect(result.ok).toBe(true)
    expect(readFileSync(path.join(root, "result.txt"), "utf8")).toBe(
      "from local\nfrom trap\n",
    )
    expect(result.log.match(/^\$ /gm)).toHaveLength(1)
    expect(result.log).toContain('local value="from local"')
    expect(result.log).toContain("child output")
  })

  test("normalizes a CRLF multiline script before real execution", async () => {
    const root = makeProject()
    const source = [
      "write_result() {",
      "  local value='crlf works'",
      "  cat <<EOF > crlf-result.txt",
      "$value",
      "EOF",
      "}",
      "write_result",
    ].join("\r\n")
    const result = await runVerify(root, [{ interpreter: "bash", source }])

    expect(result.ok).toBe(true)
    expect(readFileSync(path.join(root, "crlf-result.txt"), "utf8")).toBe(
      "crlf works\n",
    )
    expect(result.log).not.toContain("\r")
  })

  test("merges stderr into stdout before alternating writes reach the parent", async () => {
    const root = makeProject()
    const result = await runVerify(root, [
      {
        interpreter: "sh",
        source: `printf 'stdout-1\\n'
printf 'stderr-1\\n' >&2
printf 'stdout-2\\n'
printf 'stderr-2\\n' >&2`,
      },
    ])

    expect(result.ok).toBe(true)
    expect(result.log).toContain(
      "stdout-1\nstderr-1\nstdout-2\nstderr-2\nexit=0",
    )
  })

  test("executes an indented Bash fence with a column-zero heredoc terminator", async () => {
    const root = makeProject()
    const blocks = extractVerifyBlocks(`## Verify commands

  \`\`\`bash
  cat <<'EOF' > indented-heredoc.txt
  expected
  EOF
  printf reached > after-heredoc.txt
  \`\`\`
`)
    const result = await runVerify(root, blocks)

    expect(blocks).toEqual([
      {
        interpreter: "bash",
        source:
          "cat <<'EOF' > indented-heredoc.txt\nexpected\nEOF\nprintf reached > after-heredoc.txt\n",
      },
    ])
    expect(result.ok).toBe(true)
    expect(readFileSync(path.join(root, "indented-heredoc.txt"), "utf8")).toBe(
      "expected\n",
    )
    expect(readFileSync(path.join(root, "after-heredoc.txt"), "utf8")).toBe(
      "reached",
    )
  })

  test("preserves explicit Bash pipefail and allows scripts to control options", async () => {
    const root = makeProject()
    const pipe = await runVerify(root, [
      {
        interpreter: "bash",
        source:
          "set -o pipefail\nfalse | true\nprintf unreachable > pipe-result.txt",
      },
    ])
    const controlled = await runVerify(root, [
      {
        interpreter: "bash",
        source:
          "set +e\nfalse\nfalse | true\nprintf reached > controlled-result.txt",
      },
    ])
    const sh = await runVerify(root, [
      {
        interpreter: "sh",
        source:
          "ps -p $$ -o comm= > sh-interpreter.txt\nvalue='from sh'\nprintf '%s\\n' \"$value\" > sh-result.txt",
      },
    ])

    expect(pipe.ok).toBe(false)
    expect(existsSync(path.join(root, "pipe-result.txt"))).toBe(false)
    expect(pipe.log).toContain("$ bash -e [verification block]")
    expect(controlled.ok).toBe(true)
    expect(existsSync(path.join(root, "controlled-result.txt"))).toBe(true)
    expect(sh.ok).toBe(true)
    expect(sh.log).toContain("$ sh -e [verification block]")
    expect(
      path.basename(
        readFileSync(path.join(root, "sh-interpreter.txt"), "utf8").trim(),
      ),
    ).toBe("sh")
    expect(readFileSync(path.join(root, "sh-result.txt"), "utf8")).toBe(
      "from sh\n",
    )
  })

  test("fails closed and stops before later lines and blocks", async () => {
    const root = makeProject()
    const result = await runVerify(root, [
      {
        interpreter: "bash",
        source: "false\n$ prompt\nprintf reached > same-block.txt",
      },
      {
        interpreter: "bash",
        source: "printf reached > second-block.txt",
      },
    ])

    expect(result.ok).toBe(false)
    expect(existsSync(path.join(root, "same-block.txt"))).toBe(false)
    expect(existsSync(path.join(root, "second-block.txt"))).toBe(false)
    expect(result.log.match(/^\$ /gm)).toHaveLength(1)
    expect(result.log).toContain("| $ prompt")
  })

  test("removes the temporary script directory after execution", async () => {
    const root = makeProject()
    const result = await runVerify(root, [
      {
        interpreter: "sh",
        source: 'dirname "$0" > script-directory.txt',
      },
    ])
    const scriptDirectory = readFileSync(
      path.join(root, "script-directory.txt"),
      "utf8",
    ).trim()

    expect(result.ok).toBe(true)
    expect(existsSync(scriptDirectory)).toBe(false)
    expect(result.log).not.toContain(scriptDirectory)
  })

  test.skipIf(process.platform === "win32")(
    "kills a TERM-ignoring child process tree before temp cleanup",
    async () => {
      const root = makeProject()
      const startedAt = Date.now()
      const result = await runVerify(
        root,
        [
          {
            interpreter: "sh",
            source: `dirname "$0" > timeout-script-directory.txt
(
  trap '' TERM
  while :; do :; done
) &
child_pid=$!
printf '%s\\n' "$child_pid" > timeout-child.pid
wait "$child_pid"`,
          },
        ],
        200,
      )
      const elapsed = Date.now() - startedAt
      const childPid = Number(
        readFileSync(path.join(root, "timeout-child.pid"), "utf8").trim(),
      )
      const scriptDirectory = readFileSync(
        path.join(root, "timeout-script-directory.txt"),
        "utf8",
      ).trim()

      expect(result.ok).toBe(false)
      expect(elapsed).toBeLessThan(2_000)
      expect(await processExited(childPid)).toBe(true)
      expect(existsSync(scriptDirectory)).toBe(false)
      expect(result.log).toContain("verification timed out after 200ms")
    },
  )

  test.skipIf(process.platform === "win32")(
    "interruption kills descendants before removing the verification directory",
    async () => {
      const root = makeProject()
      const directoryFile = path.join(root, "cancel-script-directory.txt")
      const pidFile = path.join(root, "cancel-child.pid")
      const { layer } = withFake()
      const observed = await Effect.runPromise(
        Effect.gen(function* () {
          const vcs = yield* Vcs
          const fiber = yield* Effect.forkChild(
            vcs.runVerify(
              root,
              [
                {
                  interpreter: "sh",
                  source: `dirname "$0" > cancel-script-directory.txt
(
  trap '' TERM
  while :; do :; done
) &
printf '%s\n' "$!" > cancel-child.pid
wait`,
                },
              ],
              10_000,
            ),
          )
          yield* Effect.promise(async () => {
            for (let attempt = 0; attempt < 100; attempt++) {
              if (existsSync(directoryFile) && existsSync(pidFile)) return
              await new Promise((resolve) => setTimeout(resolve, 10))
            }
            throw new Error("verification child did not start")
          })
          const childPid = Number(readFileSync(pidFile, "utf8").trim())
          const scriptDirectory = readFileSync(directoryFile, "utf8").trim()
          yield* Fiber.interrupt(fiber)
          return { childPid, scriptDirectory }
        }).pipe(Effect.provide(layer)),
      )

      expect(await processExited(observed.childPid)).toBe(true)
      expect(existsSync(observed.scriptDirectory)).toBe(false)
    },
  )

  test.skipIf(process.platform === "win32")(
    "kills a descendant in a new session before temp cleanup",
    async () => {
      const root = makeProject()
      const startedAt = Date.now()
      const result = await runVerify(
        root,
        [
          {
            interpreter: "sh",
            source: `dirname "$0" > escaped-script-directory.txt
node <<'NODE'
const { spawn } = require("node:child_process")
const { writeFileSync } = require("node:fs")
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "ignore",
})
writeFileSync("escaped-child.pid", String(child.pid))
child.unref()
setInterval(() => {}, 1000)
NODE`,
          },
        ],
        500,
      )
      const elapsed = Date.now() - startedAt
      const childPid = Number(
        readFileSync(path.join(root, "escaped-child.pid"), "utf8").trim(),
      )
      const scriptDirectory = readFileSync(
        path.join(root, "escaped-script-directory.txt"),
        "utf8",
      ).trim()

      expect(result.ok).toBe(false)
      expect(elapsed).toBeLessThan(2_000)
      expect(await processExited(childPid)).toBe(true)
      expect(existsSync(scriptDirectory)).toBe(false)
      expect(result.log).toContain("verification timed out after 500ms")
    },
  )
})
