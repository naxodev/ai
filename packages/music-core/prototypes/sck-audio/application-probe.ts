/** Entrypoint for one separately approved discovery action. Never creates a stream. */
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { helperError } from "../../audio/helper-process.ts"
import { inspectApplicationDiscovery } from "./application-check.ts"
import { applicationDiscovery } from "./application-discovery.ts"
import { claimDiagnosticAttempt } from "./source-trace.ts"

export async function runApplicationDiscovery() {
  const directory = join(
    import.meta.dir,
    applicationDiscovery.evidenceDirectory,
  )
  await mkdir(directory, { recursive: true })
  const startedAt = new Date().toISOString()
  const result = await Effect.runPromise(
    inspectApplicationDiscovery(
      Effect.tryPromise({
        try: () =>
          claimDiagnosticAttempt(
            directory,
            applicationDiscovery.stage,
            startedAt,
          ),
        catch: () => helperError("unavailable"),
      }),
    ),
  )
  const artifact = {
    stage: applicationDiscovery.stage,
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
  if (
    process.argv.length !== 3 ||
    process.argv[2] !== applicationDiscovery.stage
  )
    throw new Error("Choose discover")
  await runApplicationDiscovery()
}
