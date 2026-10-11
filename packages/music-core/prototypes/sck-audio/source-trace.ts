import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const sourceTrace = {
  stage: "trace",
  buildFlag: "--source-trace",
  appName: "Kaset SCK Source Trace",
  bundleIdentifier: "dev.naxo.music.sck-source-trace.20261011",
} as const

/** Claim before creating the daemon. A restart cannot silently repeat a trace. */
export async function claimSourceTrace(directory: string, startedAt: string) {
  await claimDiagnosticAttempt(directory, sourceTrace.stage, startedAt)
}

export async function claimDiagnosticAttempt(
  directory: string,
  stage: "trace" | "discover" | "capture" | "exclude",
  startedAt: string,
) {
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "attempt.json"),
    JSON.stringify({ stage, startedAt }) + "\n",
    { flag: "wx" },
  )
}
