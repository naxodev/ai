import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { OperationLocked } from "../errors.ts"
import {
  globalSetupLockPath,
  repositoryLockPath,
  withGlobalSetupLock,
  withRepositoryLock,
  withSetupLocks,
} from "./operation-lock.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function project(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name))
  roots.push(root)
  return root
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 100 && !fs.existsSync(file); attempt++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  expect(fs.existsSync(file)).toBe(true)
}

function writeOwner(lock: string, owner: { pid: number; token: string }): void {
  fs.mkdirSync(lock, { mode: 0o700 })
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify(owner), {
    mode: 0o600,
  })
}

describe("withRepositoryLock", () => {
  test("rejects a live owner in the same process", async () => {
    const root = project("apnea-lock-contention-")
    const fiber = Effect.runFork(withRepositoryLock(root, Effect.never))
    await waitForFile(repositoryLockPath(root))

    await expect(
      Effect.runPromise(withRepositoryLock(root, Effect.void)),
    ).rejects.toBeInstanceOf(OperationLocked)

    await Effect.runPromise(Fiber.interrupt(fiber))
  })

  test("refuses a dead owner until the validated lock path is manually removed", async () => {
    const root = project("apnea-lock-stale-")
    const lock = repositoryLockPath(root)
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 })
    writeOwner(lock, { pid: 2_147_483_647, token: "old" })

    const error = await Effect.runPromise(
      Effect.flip(withRepositoryLock(root, Effect.void)),
    )

    expect(error).toBeInstanceOf(OperationLocked)
    expect(error.message).toContain(lock)
    expect(error.message).toContain("Remove this lock directory manually")
    expect(fs.existsSync(lock)).toBe(true)

    fs.rmSync(lock, { recursive: true })
    await Effect.runPromise(withRepositoryLock(root, Effect.void))
    expect(fs.existsSync(lock)).toBe(false)
  })

  test("releases after failure and interruption", async () => {
    const root = project("apnea-lock-release-")
    const lock = repositoryLockPath(root)

    await expect(
      Effect.runPromise(withRepositoryLock(root, Effect.fail("expected"))),
    ).rejects.toBe("expected")
    expect(fs.existsSync(lock)).toBe(false)

    await expect(
      Effect.runPromise(withRepositoryLock(root, Effect.die("defect"))),
    ).rejects.toThrow()
    expect(fs.existsSync(lock)).toBe(false)

    const fiber = Effect.runFork(withRepositoryLock(root, Effect.never))
    await waitForFile(lock)
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(fs.existsSync(lock)).toBe(false)
  })

  test("never displaces a concurrently published live replacement owner", async () => {
    const root = project("apnea-lock-token-")
    const lock = repositoryLockPath(root)

    await Effect.runPromise(
      withRepositoryLock(
        root,
        Effect.sync(() => {
          fs.renameSync(lock, `${lock}.displaced`)
          writeOwner(lock, { pid: process.pid, token: "replacement" })
        }),
      ),
    )

    expect(fs.existsSync(lock)).toBe(true)
    expect(
      JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).token,
    ).toBe("replacement")
    fs.rmSync(lock, { recursive: true })
    fs.rmSync(`${lock}.displaced`, { recursive: true })
  })

  test("refuses symlinked, oversized, and permissive owner metadata", async () => {
    const root = project("apnea-lock-owner-validation-")
    const lock = repositoryLockPath(root)
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 })

    fs.mkdirSync(lock, { mode: 0o700 })
    fs.symlinkSync("outside", path.join(lock, "owner.json"))
    const malformed = await Effect.runPromise(
      Effect.flip(withRepositoryLock(root, Effect.void)),
    )
    expect(malformed).toBeInstanceOf(OperationLocked)
    expect(malformed.message).toContain(lock)
    expect(malformed.message).toContain("Remove this lock directory manually")
    fs.rmSync(lock, { recursive: true })

    writeOwner(lock, { pid: process.pid, token: "x".repeat(5_000) })
    await expect(
      Effect.runPromise(withRepositoryLock(root, Effect.void)),
    ).rejects.toBeInstanceOf(OperationLocked)
    fs.rmSync(lock, { recursive: true })

    writeOwner(lock, { pid: process.pid, token: "permissive" })
    fs.chmodSync(path.join(lock, "owner.json"), 0o666)
    await expect(
      Effect.runPromise(withRepositoryLock(root, Effect.void)),
    ).rejects.toBeInstanceOf(OperationLocked)
    fs.rmSync(lock, { recursive: true })
  })

  test("does not contend across distinct repository roots", async () => {
    const first = project("apnea-lock-first-")
    const second = project("apnea-lock-second-")
    const fiber = Effect.runFork(withRepositoryLock(first, Effect.never))
    await waitForFile(repositoryLockPath(first))

    await Effect.runPromise(withRepositoryLock(second, Effect.void))

    await Effect.runPromise(Fiber.interrupt(fiber))
  })
})

describe("global setup lock", () => {
  test("serializes setup merges from distinct repositories", async () => {
    const home = project("apnea-global-lock-home-")
    const firstRoot = project("apnea-global-lock-first-")
    const secondRoot = project("apnea-global-lock-second-")
    const merged = new Set(["base"])

    await Effect.runPromise(
      Effect.gen(function* () {
        const firstRead = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        const first = yield* Effect.forkChild(
          withSetupLocks(
            home,
            firstRoot,
            true,
            Effect.gen(function* () {
              const snapshot = new Set(merged)
              yield* Deferred.succeed(firstRead, undefined)
              yield* Deferred.await(releaseFirst)
              snapshot.add("first")
              merged.clear()
              for (const value of snapshot) merged.add(value)
            }),
            Effect.yieldNow,
          ),
        )
        yield* Deferred.await(firstRead)

        const second = yield* Effect.forkChild(
          withSetupLocks(
            home,
            secondRoot,
            true,
            Effect.sync(() => {
              const snapshot = new Set(merged)
              snapshot.add("second")
              merged.clear()
              for (const value of snapshot) merged.add(value)
            }),
            Effect.yieldNow,
          ),
        )
        yield* Effect.yieldNow
        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
      }),
    )

    expect([...merged].sort()).toEqual(["base", "first", "second"])
  })

  test("releases after setup failure and interruption", async () => {
    const home = project("apnea-global-lock-release-")
    const lock = globalSetupLockPath(home)

    await expect(
      Effect.runPromise(withGlobalSetupLock(home, Effect.fail("expected"))),
    ).rejects.toBe("expected")
    expect(fs.existsSync(lock)).toBe(false)

    const fiber = Effect.runFork(withGlobalSetupLock(home, Effect.never))
    await waitForFile(lock)
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(fs.existsSync(lock)).toBe(false)
    await Effect.runPromise(withGlobalSetupLock(home, Effect.void))
  })

  test("never retries a stale global setup owner", async () => {
    const home = project("apnea-global-lock-stale-")
    const lock = globalSetupLockPath(home)
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 })
    writeOwner(lock, { pid: 2_147_483_647, token: "stale-global" })

    const error = await Effect.runPromise(
      Effect.flip(
        withGlobalSetupLock(
          home,
          Effect.void,
          Effect.die("stale lock was retried"),
        ),
      ),
    )
    expect(error).toBeInstanceOf(OperationLocked)
    if (error instanceof OperationLocked) expect(error.reason).toBe("stale")
    expect(fs.existsSync(lock)).toBe(true)
    fs.rmSync(lock, { recursive: true })
  })
})
