/** Synthetic native checks only. Never constructs SCStream or queries shareable content. */
import { sckHelperPath } from "./adapter.ts"

for (const [scenario, expected] of [
  ["pcm", 0],
  ["shutdown", 0],
  ["policy", 0],
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
    console.log(`${scenario}: passed (${exit})`)
  } finally {
    clearTimeout(timer)
  }
}
