/** Only a separately approved isolated app action may run this two-stream entrypoint. */
import { mkdir, open } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { Effect } from "effect"
import { helperError } from "../../audio/helper-process.ts"
import { claimDiagnosticAttempt } from "./source-trace.ts"
import { safariExclusion } from "./safari-exclusion.ts"
import { inspectSafariExclusion } from "./safari-exclusion-check.ts"

export async function runSafariExclusion() {
  const directory = join(import.meta.dir, safariExclusion.evidenceDirectory)
  await mkdir(directory, { recursive: true })
  const startedAt = new Date().toISOString()
  const result = await Effect.runPromise(
    inspectSafariExclusion(
      Effect.tryPromise({
        try: async (signal) => {
          const file = await open(safariExclusion.tonePagePath, "r")
          try {
            const page = Buffer.alloc(16385)
            const { bytesRead } = await file.read(page, 0, page.length, 0)
            if (
              bytesRead > 16384 ||
              createHash("sha256")
                .update(page.subarray(0, bytesRead))
                .digest("hex") !== safariExclusion.tonePageDigest
            )
              throw new Error("The reviewed tone page changed")
          } finally {
            await file.close()
          }
          signal.throwIfAborted()
          await claimDiagnosticAttempt(
            directory,
            safariExclusion.stage,
            startedAt,
          )
        },
        catch: () => helperError("unavailable"),
      }),
    ),
  )
  const artifact = {
    stage: safariExclusion.stage,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...result,
  }
  await Bun.write(
    join(directory, "exclusion-result.json"),
    JSON.stringify(artifact, null, 2),
  )
  console.log(JSON.stringify(artifact))
}
if (import.meta.main) {
  if (process.argv.length !== 3 || process.argv[2] !== safariExclusion.stage)
    throw new Error("Choose exclude")
  await runSafariExclusion()
}
