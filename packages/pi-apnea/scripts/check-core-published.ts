import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  runBoundedCommand,
  type BoundedCommandRunner,
} from "./bounded-process.ts"

const CORE_PACKAGE = "@naxodev/apnea"
export const NPM_VIEW_TIMEOUT_MS = 30_000

export type CorePublishGateOptions = {
  manifestPath: string
  queryVersions: () => Promise<string[]>
  sleep: (milliseconds: number) => Promise<void>
  attempts?: number
  retryDelayMs?: number
}

export async function checkCorePublished(
  options: CorePublishGateOptions,
): Promise<void> {
  const manifest = JSON.parse(await readFile(options.manifestPath, "utf8")) as {
    dependencies?: Record<string, unknown>
  }
  const range = manifest.dependencies?.[CORE_PACKAGE]
  if (typeof range !== "string" || range.length === 0) {
    throw new Error(
      `${options.manifestPath} has no ${CORE_PACKAGE} dependency range`,
    )
  }

  const attempts = options.attempts ?? 60
  const retryDelayMs = options.retryDelayMs ?? 5_000
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("attempts must be a positive integer")
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const versions = await options.queryVersions()
      if (versions.some((version) => Bun.semver.satisfies(version, range)))
        return
    } catch {
      // Registry visibility and network failures use the same bounded retry.
    }
    if (attempt < attempts) await options.sleep(retryDelayMs)
  }

  throw new Error(
    `no published ${CORE_PACKAGE} version satisfies ${range} after ${attempts} attempts`,
  )
}

export async function queryNpmVersions(
  run: BoundedCommandRunner = runBoundedCommand,
): Promise<string[]> {
  const result = await run(
    ["npm", "view", CORE_PACKAGE, "versions", "--json"],
    {
      label: `npm view ${CORE_PACKAGE}`,
      timeoutMs: NPM_VIEW_TIMEOUT_MS,
    },
  )
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "npm view failed")
  }
  const value = JSON.parse(result.stdout) as unknown
  if (typeof value === "string") return [value]
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value
  }
  throw new Error("npm returned an invalid versions response")
}

if (import.meta.main) {
  await checkCorePublished({
    manifestPath: resolve(import.meta.dir, "../package.json"),
    queryVersions: queryNpmVersions,
    sleep: Bun.sleep,
  })
  console.log("A compatible @naxodev/apnea version is published.")
}
