import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { spawn, type ChildProcess } from "node:child_process"
import { Effect, Exit } from "effect"
import {
  makeProcessService,
  ProcessOutputError,
  ProcessTimeoutError,
  terminateProcessTree,
  type ProcessChild,
  type ProcessRuntimeDeps,
} from "./process.ts"

describe("Process", () => {
  test("raw stdout preserves invalid UTF-8 and NUL bytes while text callers still decode", async () => {
    const service = makeProcessService()
    const options = {
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(Buffer.from([0xff, 0, 0xc3, 0x28, 10]))",
      ],
      timeoutMs: 2_000,
    }
    const bytes = Buffer.from([0xff, 0, 0xc3, 0x28, 10])
    expect((await Effect.runPromise(service.runRaw(options))).stdout).toEqual(
      bytes,
    )
    expect((await Effect.runPromise(service.run(options))).stdout).toBe(
      bytes.toString("utf8"),
    )
  })

  test("bounds output and reports the captured stream", async () => {
    const service = makeProcessService()
    const exit = await Effect.runPromiseExit(
      service.run({
        command: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(128))"],
        timeoutMs: 2_000,
        outputLimitBytes: 32,
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Exit.findErrorOption(exit)
      expect(error._tag).toBe("Some")
      if (error._tag === "Some") {
        expect(error.value).toBeInstanceOf(ProcessOutputError)
        expect((error.value as ProcessOutputError).stream).toBe("stdout")
        expect((error.value as ProcessOutputError).stdout).toHaveLength(32)
      }
    }
  })

  test("times out asynchronously instead of hanging on a child", async () => {
    const service = makeProcessService()
    const started = performance.now()
    const exit = await Effect.runPromiseExit(
      service.run({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        timeoutMs: 50,
        terminationGraceMs: 50,
      }),
    )

    expect(performance.now() - started).toBeLessThan(2_000)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Exit.findErrorOption(exit)
      expect(error._tag).toBe("Some")
      if (error._tag === "Some") {
        expect(error.value).toBeInstanceOf(ProcessTimeoutError)
      }
    }
  })

  test("ignores a late stdin EPIPE after the child has exited successfully", async () => {
    const child = new EventEmitter() as ChildProcess
    const stdin = new EventEmitter() as NonNullable<ChildProcess["stdin"]>
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    Object.assign(child, {
      pid: 42,
      exitCode: null,
      stdin,
      stdout,
      stderr,
      kill: () => true,
    })
    Object.assign(stdin, {
      end: () => {
        Object.defineProperty(child, "exitCode", { value: 0, writable: true })
        const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" })
        stdin.emit("error", error)
        stdout.end()
        stderr.end()
        child.emit("close", 0)
      },
    })
    const deps = {
      platform: "linux" as const,
      kill: () => {},
      sleep: async () => {},
      snapshotDescendants: async () => [],
      taskkill: async () => false,
      processRunning: () => false,
      spawn: (() => {
        queueMicrotask(() => child.emit("spawn"))
        return child
      }) as typeof spawn,
    } satisfies ProcessRuntimeDeps & { spawn: typeof spawn }

    const result = await Effect.runPromise(
      makeProcessService(deps).run({
        command: "fake",
        stdin: "input",
        timeoutMs: 1_000,
      }),
    )

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })
})

describe("terminateProcessTree", () => {
  test("uses bounded taskkill on Windows before the parent fallback", async () => {
    const calls: string[] = []
    const child = {
      pid: 42,
      kill: (signal?: NodeJS.Signals) => calls.push(`child:${signal}`),
    } as unknown as ProcessChild
    const deps: ProcessRuntimeDeps = {
      platform: "win32",
      kill: () => {},
      sleep: async () => {},
      snapshotDescendants: async () => [],
      taskkill: async (pid, timeoutMs) => {
        calls.push(`taskkill:${pid}:${timeoutMs}`)
        return false
      },
      processRunning: () => false,
    }

    await terminateProcessTree(child, 25, deps)

    expect(calls).toEqual(["taskkill:42:25", "child:SIGKILL"])
  })

  test("kills process-group escapees captured before parent termination", async () => {
    const calls: string[] = []
    const child = {
      pid: 50,
      kill: () => {},
    } as unknown as ProcessChild
    const deps: ProcessRuntimeDeps = {
      platform: "linux",
      kill: (pid, signal) => {
        calls.push(`${pid}:${signal}`)
      },
      sleep: async () => {},
      snapshotDescendants: async () => [51, 52],
      taskkill: async () => false,
      processRunning: () => false,
    }

    await terminateProcessTree(child, 10, deps)

    expect(calls).toContain("-50:SIGTERM")
    expect(calls).toContain("51:SIGTERM")
    expect(calls).toContain("52:SIGTERM")
  })
})
