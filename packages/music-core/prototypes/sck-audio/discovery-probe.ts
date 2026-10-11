/** Only a separately approved app action runs protected discovery. No stream. */
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { helperError } from "../../audio/helper-process.ts"
import { inspectSourceDiscovery } from "./discovery-check.ts"
import { claimDiagnosticAttempt } from "./source-trace.ts"
import { sourceDiscovery } from "./source-discovery.ts"

export async function runSourceDiscovery() {
  const directory = join(import.meta.dir, sourceDiscovery.evidenceDirectory)
  await mkdir(directory, { recursive: true })
  const startedAt = new Date().toISOString()
  const result = await Effect.runPromise(
    inspectSourceDiscovery(
      Effect.tryPromise({
        try: () =>
          claimDiagnosticAttempt(directory, sourceDiscovery.stage, startedAt),
        catch: () => helperError("unavailable"),
      }),
    ),
  )
  const artifact = {
    stage: sourceDiscovery.stage,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...result,
  }
  await Bun.write(
    join(directory, "discovery-result.json"),
    JSON.stringify(artifact, null, 2),
  )
  console.log(JSON.stringify(artifact))
}

if (import.meta.main) {
  if (process.argv.length !== 3 || process.argv[2] !== sourceDiscovery.stage)
    throw new Error("Choose discover")
  await runSourceDiscovery()
}
