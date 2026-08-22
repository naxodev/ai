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
import { Effect, Exit, Layer, Option } from "effect"
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
  filterAppPaths,
  fingerprintUntrackedFiles,
  gitCommitPhaseWithCommand,
  treeFingerprintWithCommand,
  utf8BytesAfterAppend,
  verifyBlockDisplayByteLength,
} from "./vcs.ts"
import { FileSystemLive } from "./file-system.ts"

function withFake(initial: Record<string, string> = {}) {
  const fake = makeFakeFileSystem(initial)
  // Also mark directories that exist as empty keys via mkdir semantics —
  // exists returns true for dirs. Seed .jj/.git as empty file markers.
  const layer = Layer.provideMerge(VcsLive, fake.layer)
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
    effect.pipe(Effect.provide(Layer.provide(VcsLive, FileSystemLive))),
  )
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
          yield* (yield* Vcs).commitPhase(root, "git", "unsafe alias")
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
      }).pipe(Effect.provide(Layer.provide(VcsLive, FileSystemLive))),
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

    await realVcs(
      Effect.gen(function* () {
        yield* (yield* Vcs).commitPhase(root, "git", "safe commit")
      }),
    )
    expect(command(root, "git", ["ls-files", ".apnea"])).toBe("")
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
          yield* (yield* Vcs).commitPhase(root, "git", "unsafe commit")
        }),
      ),
    ).rejects.toThrow(".apnea")

    command(root, "git", ["commit", "-qm", "track runtime"])
    rmSync(path.join(root, ".apnea", "state.json"))
    command(root, "git", ["add", "-u", "--", ".apnea"])
    await expect(
      realVcs(
        Effect.gen(function* () {
          yield* (yield* Vcs).commitPhase(root, "git", "unsafe deletion")
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

    await realVcs(
      Effect.gen(function* () {
        yield* (yield* Vcs).commitPhase(root, "jj", "safe source commit")
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
    ).toBe("safe source commit")
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
          yield* (yield* Vcs).commitPhase(root, "jj", "must refuse")
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

    await realVcs(
      Effect.gen(function* () {
        yield* (yield* Vcs).commitPhase(root, "jj", "safe jj commit")
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
      }).pipe(Effect.provide(Layer.provide(VcsLive, FileSystemLive))),
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

    await expect(
      Effect.runPromise(
        gitCommitPhaseWithCommand(
          root,
          "must not move",
          (bin, args, cwd, env) => {
            if (args[0] === "read-tree" && env === undefined) {
              return { ok: false, stdout: "", stderr: "injected", code: 1 }
            }
            return commandResult(cwd, bin, args, env)
          },
        ),
      ),
    ).rejects.toThrow("injected")
    expect(command(root, "git", ["rev-parse", "HEAD"]).trim()).toBe(before)
  })
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
