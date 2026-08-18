import { test as bunTest } from "bun:test"

/**
 * Real managed-session transport is owner-only AF_UNIX sockets with chmod and
 * path-identity proofs. That is the production macOS/Linux seam. Windows CI
 * AF_UNIX support is incomplete: bind/connect against `/tmp/*.sock` paths and
 * peer-close wait can hang with open handles until the job timeout.
 *
 * WHY: skip real AF_UNIX bind/connect/close, Unix-daemon spawn, owner-only
 * `/tmp` runtime proofs, and reconnecting Effect seams that still schedule
 * production client work off darwin/linux. Keep pure Config, schema,
 * injected-launcher, signal, and close-helper unit tests on every OS via
 * `createSessionTest` without reindenting bodies.
 */
export const unixSessionSocketsSupported =
  process.platform === "darwin" || process.platform === "linux"

export type SessionTestFn = (
  name: string,
  fn: () => void | Promise<void>,
) => void

/**
 * Alias bun's test function so Unix-session-only cases skip off darwin/linux
 * without reindenting test bodies (prettier stays quiet).
 */
export const createSessionTest = (
  baseTest: typeof bunTest,
  afUnixTests: ReadonlySet<string>,
): SessionTestFn => {
  const skipUnix = baseTest.skipIf(!unixSessionSocketsSupported)
  return (name, fn) => {
    if (afUnixTests.has(name)) skipUnix(name, fn)
    else baseTest(name, fn)
  }
}

/** Direct skip helper when a single test must opt in explicitly. */
export const testUnixSession = bunTest.skipIf(!unixSessionSocketsSupported)
