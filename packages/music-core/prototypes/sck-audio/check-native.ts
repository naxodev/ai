/** Synthetic native checks only. Never constructs SCStream or queries shareable content. */
import { sckHelperPath } from "./adapter.ts"
import { sckSourceCheckpoints } from "./diagnostics.ts"

for (const [scenario, expected] of [
  ["pcm", 0],
  ["shutdown", 0],
  ["policy", 0],
  ["source-guards", 0],
  ["discovery-flow", 0],
  ["denied", 77],
] as const) {
  const child = Bun.spawn([sckHelperPath, "--self-test", scenario], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exit !== expected || stdout.length !== 0)
      throw new Error(`${scenario}: unexpected exit/output ${exit}: ${stderr}`)
    if (scenario === "source-guards") {
      const reasons = stderr
        .trim()
        .split("\n")
        .map((line) => {
          const event: unknown = JSON.parse(line)
          if (
            typeof event !== "object" ||
            event === null ||
            !("event" in event) ||
            event.event !== "music-audio-helper-stop" ||
            !("reason" in event) ||
            typeof event.reason !== "string"
          )
            throw new Error("Invalid synthetic source checkpoint")
          return event.reason
        })
      const expectedReasons = new Set<string>(sckSourceCheckpoints)
      if (
        reasons.some((reason) => !expectedReasons.has(reason)) ||
        new Set(reasons).size !== expectedReasons.size
      )
        throw new Error(
          "Native source checkpoints disagree with the recorder allowlist",
        )
    }
    console.log(`${scenario}: passed (${exit})`)
  } finally {
    clearTimeout(timer)
  }
}
