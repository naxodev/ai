import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  NPM_VIEW_TIMEOUT_MS,
  checkCorePublished,
  queryNpmVersions,
} from "./check-core-published.ts"

async function manifest(range: string): Promise<{
  path: string
  cleanup: () => Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), "pi-apnea-core-gate-"))
  const path = join(directory, "package.json")
  await writeFile(
    path,
    JSON.stringify({ dependencies: { "@naxodev/apnea": range } }),
  )
  return { path, cleanup: () => rm(directory, { recursive: true }) }
}

describe("checkCorePublished", () => {
  test("bounds each npm view request", async () => {
    let timeoutMs: number | undefined
    const versions = await queryNpmVersions(async (_args, options) => {
      timeoutMs = options.timeoutMs
      return { exitCode: 0, stdout: '["0.1.0","0.2.0"]', stderr: "" }
    })

    expect(versions).toEqual(["0.1.0", "0.2.0"])
    expect(timeoutMs).toBe(NPM_VIEW_TIMEOUT_MS)
  })

  test("accepts a published core version that satisfies the manifest range", async () => {
    const fixture = await manifest("^0.1.0")
    try {
      await checkCorePublished({
        manifestPath: fixture.path,
        queryVersions: async () => ["0.0.9", "0.1.4", "0.2.0"],
        sleep: async () => {},
      })
    } finally {
      await fixture.cleanup()
    }
  })

  test("retries a bounded number of times before failing", async () => {
    const fixture = await manifest("^0.2.0")
    const sleeps: number[] = []
    let queries = 0
    try {
      await expect(
        checkCorePublished({
          manifestPath: fixture.path,
          attempts: 3,
          retryDelayMs: 25,
          queryVersions: async () => {
            queries += 1
            return ["0.1.9"]
          },
          sleep: async (milliseconds) => {
            sleeps.push(milliseconds)
          },
        }),
      ).rejects.toThrow(
        "no published @naxodev/apnea version satisfies ^0.2.0 after 3 attempts",
      )
      expect(queries).toBe(3)
      expect(sleeps).toEqual([25, 25])
    } finally {
      await fixture.cleanup()
    }
  })

  test("uses semver range rules rather than string prefixes", async () => {
    const fixture = await manifest(">=0.83.0 <0.85.0")
    try {
      await checkCorePublished({
        manifestPath: fixture.path,
        queryVersions: async () => ["0.84.7"],
        sleep: async () => {},
      })
    } finally {
      await fixture.cleanup()
    }
  })

  test("allows enough default retries for coordinated release propagation", async () => {
    const fixture = await manifest("^0.2.0")
    let queries = 0
    try {
      await checkCorePublished({
        manifestPath: fixture.path,
        queryVersions: async () => {
          queries += 1
          return queries === 6 ? ["0.2.0"] : ["0.1.9"]
        },
        sleep: async () => {},
      })
      expect(queries).toBe(6)
    } finally {
      await fixture.cleanup()
    }
  })
})
