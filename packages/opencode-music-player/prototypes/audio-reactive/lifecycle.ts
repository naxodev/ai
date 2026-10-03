/** Bounded native source-exit experiment using only a quiet owned tone process. */
import { join } from "node:path"
import { build, frame } from "./run.ts"

async function main() {
  await build()
  const helper = join(import.meta.dir, "dist/audio-probe")
  const source = Bun.spawn([helper, "--tone", "3"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const sourceError = new Response(source.stderr).text()
  let capture: ReturnType<typeof Bun.spawn> | undefined
  let output:
    | Promise<{ frames: number; nonzero: number; error: string } | null>
    | undefined
  let captureError: Promise<string> | undefined
  const deadline = setTimeout(() => {
    source.kill("SIGKILL")
    capture?.kill("SIGKILL")
  }, 12_000)
  try {
    const sourceReader = source.stdout.getReader()
    const ready = await sourceReader.read()
    sourceReader.releaseLock()
    if (
      !ready.value ||
      !new TextDecoder().decode(ready.value).includes("quiet-synthetic-tone")
    )
      throw new Error("Tone source did not start")
    const started = Date.now()
    const child = Bun.spawn(
      [helper, "--pid", String(source.pid), "--seconds", "10"],
      { stdout: "pipe", stderr: "pipe" },
    )
    capture = child
    captureError = new Response(child.stderr).text()
    output = (async () => {
      let pending = ""
      let frames = 0
      let nonzero = 0
      let error = ""
      const decoder = new TextDecoder()
      for await (const chunk of child.stdout) {
        pending += decoder.decode(chunk, { stream: true })
        if (pending.length > 64 * 1024)
          throw new Error("Probe output exceeded its bound")
        let split: number
        while ((split = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, split)
          pending = pending.slice(split + 1)
          if (!line) continue
          const value: unknown = JSON.parse(line)
          const signal = frame(value)
          if (signal) {
            frames++
            if (signal.rms?.some((n) => n > 0.0001)) nonzero++
          }
          if (value && typeof value === "object" && "message" in value)
            error = String(value.message)
        }
      }
      return { frames, nonzero, error }
    })().catch((error: unknown) => {
      console.error(String(error))
      return null
    })
    const [sourceExit, captureExit, data] = await Promise.all([
      source.exited,
      child.exited,
      output,
    ])
    const elapsedMs = Date.now() - started
    if (sourceExit !== 0) throw new Error(await sourceError)
    if (
      !data ||
      captureExit !== 1 ||
      !data.error.includes("source identity changed") ||
      data.nonzero === 0 ||
      elapsedMs > 7_000
    )
      throw new Error(
        JSON.stringify({ sourceExit, captureExit, data, elapsedMs }),
      )
    console.log(
      JSON.stringify({
        result: "pass",
        frames: data.frames,
        nonzero: data.nonzero,
        captureExit,
        elapsedMs,
        observation:
          "Selected owned process exited; capture stopped instead of rebinding",
        limitation: "Actual player relaunch and device switching not tested",
      }),
    )
  } finally {
    source.kill("SIGTERM")
    capture?.kill("SIGTERM")
    try {
      await source.exited
      await capture?.exited
      await output
      await captureError
      await sourceError
    } finally {
      clearTimeout(deadline)
    }
  }
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
