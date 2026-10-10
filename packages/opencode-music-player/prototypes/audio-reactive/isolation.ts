/** LOCAL EXPERIMENT: temporarily pause/resume CLIAMP and play a quiet test tone. */
import { join } from "node:path"
import { build, frame } from "./run.ts"

async function cliamp(...args: string[]) {
  const child = Bun.spawn(["cliamp", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, error, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exit !== 0) throw new Error(error || out)
  return out
}

type Phase =
  "warmup" | "playing" | "settle" | "paused" | "other-tone" | "resumed"
type Stats = { frames: number; maxRms: number }

async function main() {
  const pid = process.argv[process.argv.indexOf("--pid") + 1]
  if (!process.argv.includes("--pid") || !pid || !/^\d+$/.test(pid))
    throw new Error("Use --pid with the verified CLIAMP output PID")
  await build()
  const initial = JSON.parse(await cliamp("remote", "state")) as {
    snapshot?: { state?: string }
  }
  if (initial.snapshot?.state !== "playing")
    throw new Error("Start CLIAMP playback before this experiment")
  const binary = join(import.meta.dir, "dist/audio-probe")
  const child = Bun.spawn([binary, "--pid", pid, "--seconds", "20"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const stats: Record<Phase, Stats> = Object.fromEntries(
    ["warmup", "playing", "settle", "paused", "other-tone", "resumed"].map(
      (name) => [name, { frames: 0, maxRms: 0 }],
    ),
  ) as Record<Phase, Stats>
  let phase: Phase = "warmup"
  let sourceFailure = ""
  let pausedByTest = false
  const diagnostics = new Response(child.stderr).text()
  const reader = (async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const bytes of child.stdout) {
      buffer += decoder.decode(bytes, { stream: true })
      if (buffer.length > 64 * 1024)
        throw new Error("Probe output exceeded its bound")
      let split: number
      while ((split = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, split)
        buffer = buffer.slice(split + 1)
        if (!line) continue
        const event: unknown = JSON.parse(line)
        const signal = frame(event)
        if (signal?.rms) {
          stats[phase].frames++
          stats[phase].maxRms = Math.max(stats[phase].maxRms, ...signal.rms)
        } else if (
          event &&
          typeof event === "object" &&
          "type" in event &&
          event.type === "error"
        )
          sourceFailure = JSON.stringify(event)
      }
    }
  })()
  // Observe read rejection immediately, then join it during cleanup.
  const readOutcome = reader.then(
    () => null,
    (error: unknown) => error,
  )
  const hardDeadline = setTimeout(() => child.kill("SIGKILL"), 22_000)
  try {
    await Bun.sleep(1_000)
    phase = "playing"
    await Bun.sleep(2_000)
    if (stats.playing.maxRms < 0.0001)
      throw new Error("No measured CLIAMP signal before pause")
    pausedByTest = true
    await cliamp("pause")
    phase = "settle"
    await Bun.sleep(1_000)
    phase = "paused"
    await Bun.sleep(2_000)
    phase = "other-tone"
    const tone = Bun.spawn([binary, "--tone", "3"], {
      stdout: "ignore",
      stderr: "pipe",
    })
    const toneError = new Response(tone.stderr).text()
    const toneExit = await tone.exited
    if (toneExit !== 0)
      throw new Error(`Other-process tone failed: ${await toneError}`)
    await toneError
    await cliamp("play")
    pausedByTest = false
    phase = "resumed"
    await Bun.sleep(3_000)
    if (sourceFailure) throw new Error(sourceFailure)
    if (stats.paused.maxRms > 0.0001 || stats["other-tone"].maxRms > 0.0001)
      throw new Error("Paused CLIAMP capture contains unexpected signal")
    if (stats.resumed.maxRms < 0.0001)
      throw new Error("CLIAMP signal did not return after resume")
    console.log(
      JSON.stringify({
        result: "pass",
        pid,
        stats,
        waveformSamplesSaved: false,
        limitations:
          "One CLIAMP process and one controlled other process; headphones and real player restart not tested",
      }),
    )
  } finally {
    // Restore the original playing state even if any assertion or source fails.
    try {
      if (pausedByTest) await cliamp("play")
    } finally {
      child.kill("SIGTERM")
      const cleanup = setTimeout(() => child.kill("SIGKILL"), 1_000)
      try {
        await child.exited
        const error = await readOutcome
        if (error) throw error
        await diagnostics
      } finally {
        clearTimeout(cleanup)
        clearTimeout(hardDeadline)
      }
    }
  }
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
