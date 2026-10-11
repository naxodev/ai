/** Fake PCM, filters, identities, and completions. No live capture or discovery. */
import { applicationCapture } from "./application-capture.ts"

for (const [args, expected] of [
  [["--self-test", "application-policy"], 0],
  [["--self-test", "application-flow"], 0],
  [["--self-test", "capture-measurements"], 0],
  [["--self-test", "capture-filter"], 0],
  [["--self-test", "capture-environment"], 0],
  [["--self-test", "capture-shutdown"], 0],
  [["--self-test", "capture-pcm"], 0],
  [["--self-test", "denied"], 77],
  [["--discover-kaset-application"], 1],
  [["--protocol", "1", "--process-id", "1"], 1],
] as const) {
  const child = Bun.spawn([applicationCapture.helperPath, ...args], {
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
    if (stdout.length !== 0 || exit !== expected)
      throw new Error(`Capture fixture failed (${exit}): ${stderr}`)
    if (
      expected === 1 &&
      stderr !== '{"event":"music-audio-helper-stop","reason":"arguments"}\n'
    )
      throw new Error("Unexpected capture command boundary")
    console.log(`${args.join(" ")}: passed (${exit})`)
  } finally {
    clearTimeout(timer)
  }
}
