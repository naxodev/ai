import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claimSourceTrace, sourceTrace } from "./source-trace.ts"

test("only one concurrent or restarted trace can claim the attempt marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sck-trace-claim-"))
  const startedAt = "2026-10-11T00:00:00.000Z"
  try {
    const results = await Promise.allSettled([
      claimSourceTrace(directory, startedAt),
      claimSourceTrace(directory, startedAt),
    ])
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1)
    const rejected = results.filter((result) => result.status === "rejected")
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({ code: "EEXIST" })
    await expect(claimSourceTrace(directory, startedAt)).rejects.toMatchObject({
      code: "EEXIST",
    })
    expect(
      JSON.parse(await readFile(join(directory, "attempt.json"), "utf8")),
    ).toEqual({ stage: sourceTrace.stage, startedAt })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
