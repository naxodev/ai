import { describe, expect, test } from "bun:test"
import {
  CommandDeadlineError,
  processTreeIsRunning,
  runBoundedCommand,
  signalChild,
  type BoundedProcessDeps,
} from "./bounded-process.ts"

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: (controller) => controller.close() })
}

describe("runBoundedCommand", () => {
  test.skipIf(process.platform !== "darwin")(
    "cleans up a macOS process group after its shell leader exits",
    async () => {
      const started = Date.now()
      await expect(
        runBoundedCommand(["sh", "-c", "sleep 2 & exit 0"], {
          label: "macOS process-group smoke",
          timeoutMs: 100,
          terminationGraceMs: 500,
        }),
      ).rejects.toThrow("macOS process-group smoke timed out after 100ms")
      expect(Date.now() - started).toBeLessThan(1_500)
    },
  )

  test("treats ESRCH as gone and EPERM as ambiguous without throwing", () => {
    const child = {
      pid: 99,
      exited: Promise.resolve(0),
      stdout: emptyStream(),
      stderr: emptyStream(),
      stdin: { write: () => {}, end: () => {} },
      kill: () => {},
    }
    const failure = (code: string) => {
      const error = new Error(code) as NodeJS.ErrnoException
      error.code = code
      return () => {
        throw error
      }
    }

    expect(signalChild(child, "SIGTERM", true, failure("ESRCH"))).toBe(false)
    expect(signalChild(child, "SIGKILL", true, failure("EPERM"))).toBe(false)
    expect(processTreeIsRunning(child, true, failure("ESRCH"))).toBe(false)
    expect(processTreeIsRunning(child, true, failure("EPERM"))).toBe(null)
  })

  test("cleans up the process group when a descendant keeps output open", async () => {
    const waits: number[] = []
    const signals: string[] = []
    let detached: boolean | undefined
    const child = {
      pid: 4321,
      exited: Promise.resolve(0),
      stdout: new ReadableStream<Uint8Array>(),
      stderr: emptyStream(),
      stdin: { write: () => {}, end: () => {} },
      kill: () => {},
    }
    const deps: BoundedProcessDeps = {
      platform: "darwin",
      spawn: (_args, options) => {
        detached = options.detached
        return child
      },
      waitForDeadline: async <T>(promise: Promise<T>, milliseconds: number) => {
        waits.push(milliseconds)
        const pending = Symbol("pending")
        const result = await Promise.race([promise, Promise.resolve(pending)])
        if (result !== pending) return result as T
        throw new CommandDeadlineError("test deadline")
      },
      signal: (_child, signal, processGroup) => {
        signals.push(`${signal}:${processGroup}`)
      },
      waitForProcessTreeExit: async (_child, _processGroup, milliseconds) => {
        waits.push(milliseconds)
        return false
      },
    }

    await expect(
      runBoundedCommand(
        ["pi", "--mode", "rpc"],
        {
          label: "Pi RPC smoke",
          timeoutMs: 100,
          terminationGraceMs: 5,
        },
        deps,
      ),
    ).rejects.toThrow(
      "Pi RPC smoke timed out after 100ms and did not exit after SIGKILL",
    )
    expect(waits).toEqual([100, 5, 5])
    expect(signals).toEqual(["SIGTERM:true", "SIGKILL:true"])
    expect(detached).toBe(true)
  })

  test("returns completed output without cleanup signals", async () => {
    const signals: string[] = []
    const deps: BoundedProcessDeps = {
      platform: "darwin",
      spawn: () => ({
        pid: 1,
        exited: Promise.resolve(0),
        stdout: new Response("ok").body!,
        stderr: emptyStream(),
        stdin: { write: () => {}, end: () => {} },
        kill: () => {},
      }),
      waitForDeadline: async (promise) => promise,
      signal: (_child, signal) => signals.push(signal),
      waitForProcessTreeExit: async () => true,
    }

    await expect(
      runBoundedCommand(
        ["npm", "pack"],
        { label: "pack", timeoutMs: 20 },
        deps,
      ),
    ).resolves.toEqual({ exitCode: 0, stdout: "ok", stderr: "" })
    expect(signals).toEqual([])
  })

  test("caps output, terminates the process tree, and retains bounded diagnostics", async () => {
    const signals: string[] = []
    const waits: number[] = []
    const deps: BoundedProcessDeps = {
      platform: "darwin",
      spawn: () => ({
        pid: 2,
        exited: new Promise<number>(() => {}),
        stdout: new Response("abcdef").body!,
        stderr: new Response("err").body!,
        stdin: { write: () => {}, end: () => {} },
        kill: () => {},
      }),
      waitForDeadline: async (promise) => promise,
      signal: (_child, signal) => signals.push(signal),
      waitForProcessTreeExit: async (_child, _processGroup, milliseconds) => {
        waits.push(milliseconds)
        return waits.length > 1
      },
    }

    let failure: Error | undefined
    try {
      await runBoundedCommand(
        ["pi"],
        {
          label: "Pi output smoke",
          timeoutMs: 100,
          terminationGraceMs: 5,
          outputLimitBytes: 4,
        },
        deps,
      )
    } catch (error) {
      failure = error as Error
    }

    expect(failure?.message).toContain(
      "Pi output smoke stdout exceeded the 4-byte output limit",
    )
    expect(failure?.message).toContain("stdout:\nabcd")
    expect(failure?.message).not.toContain("abcdef")
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(waits).toEqual([5, 5])
  })

  test("terminates active children when output capture fails", async () => {
    const signals: string[] = []
    const deps: BoundedProcessDeps = {
      platform: "darwin",
      spawn: () => ({
        pid: 3,
        exited: new Promise<number>(() => {}),
        stdout: new ReadableStream<Uint8Array>({
          start: (controller) => controller.error(new Error("read failed")),
        }),
        stderr: emptyStream(),
        stdin: { write: () => {}, end: () => {} },
        kill: () => {},
      }),
      waitForDeadline: async (promise) => promise,
      signal: (_child, signal) => signals.push(signal),
      waitForProcessTreeExit: async () => true,
    }

    await expect(
      runBoundedCommand(
        ["npm", "view"],
        { label: "npm view", timeoutMs: 100 },
        deps,
      ),
    ).rejects.toThrow("npm view output capture failed: read failed")
    expect(signals).toEqual(["SIGTERM"])
  })

  test("terminates and awaits cleanup when stdin setup throws", async () => {
    const signals: string[] = []
    const waits: number[] = []
    const deps: BoundedProcessDeps = {
      platform: "darwin",
      spawn: () => ({
        pid: 4,
        exited: new Promise<number>(() => {}),
        stdout: emptyStream(),
        stderr: emptyStream(),
        stdin: {
          write: () => {
            throw new Error("EPIPE")
          },
          end: () => {},
        },
        kill: () => {},
      }),
      waitForDeadline: async (promise) => promise,
      signal: (_child, signal) => signals.push(signal),
      waitForProcessTreeExit: async (_child, _group, milliseconds) => {
        waits.push(milliseconds)
        return waits.length > 1
      },
    }

    await expect(
      runBoundedCommand(
        ["pi"],
        {
          label: "Pi stdin smoke",
          timeoutMs: 100,
          terminationGraceMs: 5,
          stdin: "request\n",
        },
        deps,
      ),
    ).rejects.toThrow("Pi stdin smoke process setup failed: EPIPE")
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(waits).toEqual([5, 5])
  })

  test("uses bounded Windows taskkill instead of parent-only liveness", async () => {
    const taskkills: Array<{ pid: number; timeoutMs: number }> = []
    const deps: BoundedProcessDeps = {
      spawn: () => ({
        pid: 55,
        exited: Promise.resolve(0),
        stdout: new ReadableStream<Uint8Array>(),
        stderr: emptyStream(),
        stdin: { write: () => {}, end: () => {} },
        kill: () => {},
      }),
      waitForDeadline: async () => {
        throw new CommandDeadlineError("deadline")
      },
      signal: () => {
        throw new Error("direct signal should not run")
      },
      waitForProcessTreeExit: async () => {
        throw new Error("parent liveness must not prove Windows tree cleanup")
      },
      platform: "win32",
      taskkill: async (pid, timeoutMs) => {
        taskkills.push({ pid, timeoutMs })
        return true
      },
    }

    await expect(
      runBoundedCommand(
        ["pi"],
        {
          label: "Windows Pi smoke",
          timeoutMs: 100,
          terminationGraceMs: 7,
        },
        deps,
      ),
    ).rejects.toThrow("Windows Pi smoke timed out after 100ms")
    expect(taskkills).toEqual([{ pid: 55, timeoutMs: 7 }])
  })
})
