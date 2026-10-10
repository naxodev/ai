import { expect, spyOn, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { captureSeconds } from "./run.ts"
import {
  consumeFeatureLines,
  drainDiagnostics,
  outputLimit,
  readBoundedText,
  readProcessOutput,
} from "./streams.ts"

const marker = "/private/fixture/SECRET_DIAGNOSTIC_PCM_PAYLOAD"
const encode = (text: string) => new TextEncoder().encode(text)
function stream(chunks: Uint8Array[]) {
  let cancelled = false
  let index = 0
  return {
    bytes: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++]
        if (chunk) controller.enqueue(chunk)
        else controller.close()
      },
      cancel() {
        cancelled = true
      },
    }),
    cancelled: () => cancelled,
  }
}

test("a MiB of private diagnostics is drained without decoding or returning retained text", async () => {
  const bytes = encode(marker.repeat(Math.ceil((1024 * 1024) / marker.length)))
  const decode = spyOn(TextDecoder.prototype, "decode")
  const response = spyOn(Response.prototype, "text")
  try {
    expect(await drainDiagnostics(stream([bytes]).bytes)).toBeUndefined()
    expect(decode).not.toHaveBeenCalled()
    expect(response).not.toHaveBeenCalled()
  } finally {
    decode.mockRestore()
    response.mockRestore()
  }
})

test("metadata rejects an oversized chunk before copying or decoding private bytes and cancels the reader", async () => {
  const source = stream([encode(marker.repeat(outputLimit)), encode("tail")])
  const decode = spyOn(TextDecoder.prototype, "decode")
  const copy = spyOn(Uint8Array.prototype, "set")
  const response = spyOn(Response.prototype, "text")
  try {
    await expect(readBoundedText(source.bytes)).rejects.toThrow("byte limit")
    expect(copy).not.toHaveBeenCalled()
    expect(decode).not.toHaveBeenCalled()
    expect(response).not.toHaveBeenCalled()
    expect(source.cancelled()).toBe(true)
  } finally {
    decode.mockRestore()
    copy.mockRestore()
    response.mockRestore()
  }
})

test("metadata counts bytes across chunks, including multibyte text, rather than limiting after decoding", async () => {
  const text = "é".repeat(outputLimit / 2)
  expect(await readBoundedText(stream([encode(text)]).bytes)).toBe(text)
  await expect(
    readBoundedText(stream([encode(text), encode("x")]).bytes),
  ).rejects.toThrow("byte limit")
})

test("feature lines reject a huge chunk without parsing or exposing any part of its payload", async () => {
  const lines: string[] = []
  const source = stream([encode(marker.repeat(outputLimit)), encode("tail")])
  await expect(
    consumeFeatureLines(source.bytes, (line) => {
      lines.push(line)
    }),
  ).rejects.toThrow("Source output was invalid or could not be read")
  expect(lines).toEqual([])
  expect(source.cancelled()).toBe(true)
})

test("feature bounds apply to each line, not a chunk containing many valid frames", async () => {
  const lines: string[] = []
  const text = '{"bands":[0]}\n'.repeat(10_000)
  await consumeFeatureLines(stream([encode(text)]).bytes, (line) => {
    lines.push(line)
  })
  expect(lines).toHaveLength(10_000)
  expect(lines.every((line) => line === '{"bands":[0]}')).toBe(true)
})

test("cancelling a blocked diagnostic reader settles and releases its pipe lock", async () => {
  const source = new ReadableStream<Uint8Array>()
  const controller = new AbortController()
  const draining = drainDiagnostics(source, controller.signal)
  controller.abort()
  await draining
  expect(source.locked).toBe(false)
})

test("CLIAMP has a default deadline and cannot opt into an unbounded session", () => {
  expect(captureSeconds("cliamp")).toBe(30)
  expect(captureSeconds("cliamp", undefined, true)).toBe(5)
  expect(captureSeconds("native")).toBe(15)
  expect(() => captureSeconds("cliamp", "0")).toThrow()
})

// Only synthetic child processes. Never invoke CLIAMP, a helper, or an audio source.
test.skipIf(process.platform === "win32")(
  "metadata reader drains a diagnostic flood and never exposes it on failure",
  async () => {
    const script = `process.stderr.write(${JSON.stringify(marker)}.repeat(24000)); process.exitCode = 1`
    const log = spyOn(console, "error")
    try {
      await expect(
        readProcessOutput([process.execPath, "-e", script]),
      ).rejects.toThrow("Source command failed")
      expect(log).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  },
)

test.skipIf(process.platform === "win32")(
  "metadata overflow kills and joins a live producer without waiting for its deadline",
  async () => {
    const script = `process.stdout.write(${JSON.stringify(marker)}.repeat(24000)); process.stderr.write('x'.repeat(1024 * 1024)); setInterval(() => {}, 1000)`
    const started = Date.now()
    await expect(
      readProcessOutput([process.execPath, "-e", script], { timeoutMs: 5_000 }),
    ).rejects.toThrow("Source output exceeded its limit or could not be read")
    expect(Date.now() - started).toBeLessThan(3_000)
  },
)

test.skipIf(process.platform === "win32")(
  "metadata cancellation joins a blocked child and both pipes",
  async () => {
    const controller = new AbortController()
    const read = readProcessOutput(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      { signal: controller.signal },
    )
    controller.abort()
    await expect(read).rejects.toThrow("Metadata read cancelled")
  },
)

for (const malformed of [false, true]) {
  test.skipIf(process.platform === "win32")(
    `standalone fake CLIAMP discards a MiB of diagnostics and ${malformed ? "malformed" : "failed"} private stdout`,
    async () => {
      const directory = await mkdtemp(join(import.meta.dir, ".fake-cliamp-"))
      let child: ReturnType<typeof Bun.spawn> | undefined
      try {
        const executable = join(directory, "cliamp")
        const payload = malformed
          ? marker
          : JSON.stringify({ ok: false, error: marker })
        await Bun.write(
          executable,
          `#!${process.execPath}\nawait Bun.write(Bun.stderr, ${JSON.stringify(marker)}.repeat(24000)); console.log(${JSON.stringify(payload)}); process.exitCode = 1\n`,
        )
        await chmod(executable, 0o700)
        child = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, "run.ts"),
            "--source",
            "cliamp",
            "--seconds",
            "1",
            "--check",
          ],
          {
            // Assert diagnostic text, not the test runner's forced-color decoration.
            env: {
              ...process.env,
              PATH: directory,
              FORCE_COLOR: "0",
              NO_COLOR: "1",
            },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const [stdout, stderr, exit] = await Promise.all([
          readBoundedText(child.stdout as ReadableStream<Uint8Array>),
          readBoundedText(child.stderr as ReadableStream<Uint8Array>),
          child.exited,
        ])
        expect(exit).toBe(1)
        expect(stdout + stderr).not.toContain(marker)
        expect(stdout + stderr).not.toContain("/private/")
        if (malformed)
          expect(stderr.trim()).toBe(
            "Audio prototype failed; source details were discarded",
          )
        else {
          expect(stderr).toBe("")
          expect(stdout).toContain("Source reported a capture failure")
        }
      } finally {
        child?.kill("SIGKILL")
        await child?.exited
        // Remove only this test's freshly created executable directory.
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
}
