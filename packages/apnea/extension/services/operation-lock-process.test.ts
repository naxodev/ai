import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { OperationLocked } from "../errors.ts"
import { repositoryLockPath, withRepositoryLock } from "./operation-lock.ts"

const roots: string[] = []
const children: ReturnType<typeof Bun.spawn>[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill()
    await child.exited
  }
  for (const root of roots.splice(0)) {
    const lock = repositoryLockPath(root)
    for (const entry of fs.readdirSync(path.dirname(lock))) {
      if (entry.startsWith(path.basename(lock))) {
        fs.rmSync(path.join(path.dirname(lock), entry), {
          recursive: true,
          force: true,
        })
      }
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function crashedRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apnea-lock-process-"))
  roots.push(root)
  const lock = repositoryLockPath(root)
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 })
  fs.mkdirSync(lock, { mode: 0o700 })
  fs.writeFileSync(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: 2_147_483_647, token: "crashed" }),
    { mode: 0o600 },
  )
  const old = new Date(Date.now() - 120_000)
  fs.utimesSync(lock, old, old)
  return root
}

function contender(root: string, mode = "normal") {
  const control = fs.mkdtempSync(path.join(root, "contender-"))
  const child = Bun.spawn(
    [
      process.execPath,
      path.join(import.meta.dir, "../test/lock-contender.ts"),
      root,
      control,
      mode,
    ],
    { stdout: "ignore", stderr: "inherit" },
  )
  children.push(child)
  return {
    child,
    signal(name: string) {
      fs.writeFileSync(path.join(control, name), "")
    },
    async wait(name: string) {
      const file = path.join(control, name)
      const deadline = Date.now() + 10_000
      while (!fs.existsSync(file)) {
        if (child.exitCode !== null || Date.now() > deadline) {
          throw new Error(`child ${child.pid} did not reach ${name}`)
        }
        await Bun.sleep(10)
      }
    },
    async result(): Promise<{
      status: string
      reason?: string
      message?: string
    }> {
      await this.wait("result")
      return JSON.parse(fs.readFileSync(path.join(control, "result"), "utf8"))
    },
  }
}

function owner(root: string): string | null {
  const file = path.join(repositoryLockPath(root), "owner.json")
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null
}

test("serializes the token-check to rename interval so a third process cannot enter beside a live replacement", async () => {
  const root = crashedRepository()
  const first = contender(root, "rename")
  await first.wait("paused")
  const second = contender(root)
  const secondResult = await second.result()
  const beforeResume = owner(root)
  first.signal("resume")
  const firstResult = await first.result()
  const afterResume = owner(root)
  const third = contender(root)
  const thirdResult = await third.result()

  // On the old code, second enters, first displaces it, and third also enters.
  expect(thirdResult.status).toBe("denied")
  expect(thirdResult.reason).toBe("live")
  expect(secondResult.status).toBe("denied")
  expect(JSON.parse(beforeResume!).token).toBe("crashed")
  expect(firstResult.status).toBe("entered")
  expect(JSON.parse(afterResume!).pid).toBe(first.child.pid)
  expect(owner(root)).toBe(afterResume)
  first.signal("release")
  await first.wait("done")
  expect(owner(root)).toBeNull()
}, 20_000)

test("a delayed stale observation preserves the replacement before and after reclamation resumes", async () => {
  const root = crashedRepository()
  const first = contender(root, "age")
  await first.wait("paused")
  const replacement = contender(root)
  expect((await replacement.result()).status).toBe("entered")
  const liveOwner = owner(root)
  expect(JSON.parse(liveOwner!).pid).toBe(replacement.child.pid)
  const before = contender(root)
  expect((await before.result()).reason).toBe("live")
  expect(owner(root)).toBe(liveOwner)
  first.signal("resume")
  expect((await first.result()).status).toBe("denied")
  expect(owner(root)).toBe(liveOwner)
  const after = contender(root)
  expect((await after.result()).reason).toBe("live")
  expect(owner(root)).toBe(liveOwner)
  replacement.signal("release")
  await replacement.wait("done")
  expect(owner(root)).toBeNull()
}, 20_000)

test("a killed reclaimer leaves a fail-closed guard until manual recovery", async () => {
  const root = crashedRepository()
  const lock = repositoryLockPath(root)
  const guard = `${lock}.reclaim`
  const first = contender(root, "rename")
  await first.wait("paused")
  const staleOwner = owner(root)
  first.child.kill("SIGKILL")
  await first.child.exited
  expect(fs.existsSync(guard)).toBe(true)
  // Neither age nor dead guard ownership authorizes automatic guard removal.
  const old = new Date(0)
  fs.utimesSync(guard, old, old)
  const error = await Effect.runPromise(
    Effect.flip(withRepositoryLock(root, Effect.die("must not enter"))),
  )
  expect(error).toBeInstanceOf(OperationLocked)
  expect(error.message).toContain(guard)
  expect(error.message).toContain("stop all Apnea processes")
  expect(owner(root)).toBe(staleOwner)
  expect(fs.existsSync(guard)).toBe(true)

  // A guard is local to this lock, not a global lock on all repositories.
  const independent = crashedRepository()
  await Effect.runPromise(withRepositoryLock(independent, Effect.void))
  fs.rmdirSync(guard)
  await Effect.runPromise(withRepositoryLock(root, Effect.void))
  expect(owner(root)).toBeNull()
  expect(fs.existsSync(guard)).toBe(false)
}, 20_000)

test("a replacement published during tombstone cleanup keeps the canonical lock throughout cleanup", async () => {
  const root = crashedRepository()
  const first = contender(root, "removed")
  await first.wait("paused")
  expect(owner(root)).toBeNull()
  const replacement = contender(root)
  expect((await replacement.result()).status).toBe("entered")
  const liveOwner = owner(root)
  expect(JSON.parse(liveOwner!).pid).toBe(replacement.child.pid)
  const before = contender(root)
  expect((await before.result()).reason).toBe("live")
  expect(owner(root)).toBe(liveOwner)
  first.signal("resume")
  expect((await first.result()).reason).toBe("live")
  expect(owner(root)).toBe(liveOwner)
  const after = contender(root)
  expect((await after.result()).reason).toBe("live")
  expect(owner(root)).toBe(liveOwner)
  replacement.signal("release")
  await replacement.wait("done")
  expect(owner(root)).toBeNull()
  expect(fs.existsSync(`${repositoryLockPath(root)}.reclaim`)).toBe(false)
}, 20_000)

test("a failed rename releases the guard so the next call can recover", async () => {
  const root = crashedRepository()
  const staleOwner = owner(root)
  const first = contender(root, "rename-error")
  expect((await first.result()).message).toContain("injected rename failure")
  await first.wait("done")
  expect(owner(root)).toBe(staleOwner)
  expect(fs.existsSync(`${repositoryLockPath(root)}.reclaim`)).toBe(false)
  await Effect.runPromise(withRepositoryLock(root, Effect.void))
  expect(owner(root)).toBeNull()
}, 20_000)
