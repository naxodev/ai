import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Effect, Layer } from "effect"
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
  utf8BytesAfterAppend,
  verifyBlockDisplayByteLength,
} from "./vcs.ts"

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
