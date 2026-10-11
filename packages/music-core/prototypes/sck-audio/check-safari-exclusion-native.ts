/** Only synthetic buffers, clocks and lifecycle fakes. No live discovery or stream. */
import { safariExclusion } from "./safari-exclusion.ts"
for (const [args, expected] of [
  ...[
    "application-policy",
    "application-flow",
    "capture-measurements",
    "capture-filter",
    "capture-environment",
    "capture-shutdown",
    "capture-pcm",
    "exclusion-analysis",
    "exclusion-coverage",
    "exclusion-controls",
    "exclusion-clock",
    "exclusion-policy",
    "exclusion-pcm",
    "exclusion-filter",
    "exclusion-shutdown",
  ].map((scenario) => [["--self-test", scenario], 0] as const),
  [["--self-test", "denied"], 77],
  [["--capture-kaset-application"], 1],
  [["--discover-kaset-application"], 1],
  [["--protocol", "1", "--process-id", "1"], 1],
] as const) {
  const child = Bun.spawn([safariExclusion.helperPath, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== expected || stdout.length !== 0)
      throw new Error(`Native fixture failed (${code}): ${stderr}`)
    if (
      expected === 1 &&
      stderr !== '{"event":"music-audio-helper-stop","reason":"arguments"}\n'
    )
      throw new Error("Unexpected command boundary")
    console.log(`${args.join(" ")}: passed (${code})`)
  } finally {
    clearTimeout(timer)
  }
}
