import { spyOn } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { Effect } from "effect"
import { OperationLocked } from "../errors.ts"
import {
  repositoryLockPath,
  withRepositoryLock,
} from "../services/operation-lock.ts"

const [root, control, mode] = process.argv.slice(2) as [string, string, string]
const lock = repositoryLockPath(root)
const marker = (name: string) => path.join(control, name)

function wait(name: string): void {
  const deadline = Date.now() + 15_000
  const signal = new Int32Array(new SharedArrayBuffer(4))
  while (!fs.existsSync(marker(name))) {
    if (Date.now() > deadline) throw new Error(`barrier timed out: ${name}`)
    Atomics.wait(signal, 0, 0, 10)
  }
}

function barrier(): void {
  fs.writeFileSync(marker("paused"), "")
  wait("resume")
}

function publishResult(value: {
  status: string
  reason?: string
  message?: string
}): void {
  fs.writeFileSync(marker("result.tmp"), JSON.stringify(value))
  fs.renameSync(marker("result.tmp"), marker("result"))
}

// Pause at the actual syscall boundary, after the production token check.
// Each child owns its spy; the test runner and other contenders use real fs.
const rename = fs.renameSync
let intercepted = false
spyOn(fs, "renameSync").mockImplementation((source, destination) => {
  if (
    !intercepted &&
    source === lock &&
    String(destination).startsWith(`${lock}.tombstone.`)
  ) {
    intercepted = true
    if (mode === "rename") barrier()
    if (mode === "rename-error") throw new Error("injected rename failure")
    if (mode === "removed") {
      rename(source, destination)
      barrier()
      return
    }
  }
  rename(source, destination)
})

try {
  await Effect.runPromise(
    withRepositoryLock(
      root,
      Effect.sync(() => {
        publishResult({ status: "entered" })
        wait("release")
      }),
      {
        now: () => {
          if (mode === "age") barrier()
          // Force the delayed observer to reach ownership revalidation even
          // though the replacement directory has a fresh mtime.
          return Date.now() + (mode === "age" ? 120_000 : 0)
        },
      },
    ),
  )
} catch (error) {
  publishResult({
    status: "denied",
    reason: error instanceof OperationLocked ? error.reason : "error",
    message: error instanceof Error ? error.message : String(error),
  })
}
fs.writeFileSync(marker("done"), "")
