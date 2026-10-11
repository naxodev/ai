/** Only the separately approved isolated app action may run this capture entrypoint. */
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { helperError } from "../../audio/helper-process.ts"
import { inspectApplicationCapture } from "./application-capture-check.ts"
import { applicationCapture } from "./application-capture.ts"
import { claimDiagnosticAttempt } from "./source-trace.ts"

export async function runApplicationCapture() {
  const directory = join(import.meta.dir, applicationCapture.evidenceDirectory)
  await mkdir(directory, { recursive: true })
  const startedAt = new Date().toISOString()
  const result = await Effect.runPromise(
    inspectApplicationCapture(
      Effect.tryPromise({
        try: () =>
          claimDiagnosticAttempt(
            directory,
            applicationCapture.stage,
            startedAt,
          ),
        catch: () => helperError("unavailable"),
      }),
    ),
  )
  const artifact = {
    stage: applicationCapture.stage,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...result,
  }
  await Bun.write(
    join(directory, "capture-result.json"),
    JSON.stringify(artifact, null, 2),
  )
  console.log(JSON.stringify(artifact))
}

if (import.meta.main) {
  if (process.argv.length !== 3 || process.argv[2] !== applicationCapture.stage)
    throw new Error("Choose capture")
  await runApplicationCapture()
}
