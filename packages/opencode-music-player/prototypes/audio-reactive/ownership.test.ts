import { expect, spyOn, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { createAudioPrototype } from "./tui.tsx"
import {
  consumeFeatureLines,
  drainDiagnostics,
  ReaderCleanupError,
  readProcessOutput,
} from "./streams.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

function gatedChild() {
  const exit = deferred<number>()
  const cleanup = deferred<void>()
  const events: string[] = []
  const close: (() => void)[] = []
  const pipe = (name: string) => {
    let closed = false
    return new ReadableStream<Uint8Array>({
      start(controller) {
        close.push(() => {
          if (!closed) {
            closed = true
            controller.close()
          }
        })
      },
      cancel() {
        closed = true
        events.push(`${name}:cancel`)
        return cleanup.promise
      },
    })
  }
  const child = {
    stdout: pipe("stdout"),
    stderr: pipe("stderr"),
    exited: exit.promise,
    kill(signal: "SIGTERM" | "SIGKILL") {
      events.push(signal)
    },
  }
  return {
    child,
    events,
    exit,
    cleanup,
    release() {
      for (const finish of close) finish()
      exit.resolve(0)
      cleanup.resolve()
    },
  }
}

async function fixture(
  spawn: () => ReturnType<typeof gatedChild>["child"],
  read?: (command: string[], signal?: AbortSignal) => Promise<unknown>,
) {
  const handlers = new Map<string, () => Promise<void>>()
  const errors: string[] = []
  let selections = 0
  const music = { pid: 7, object: 8, bundle: "com.apple.Music", name: "Music" }
  const plugin = createAudioPrototype({
    spawn,
    read:
      read ??
      (async (command) =>
        command[0] === "media-control"
          ? {
              playing: true,
              processIdentifier: music.pid,
              bundleIdentifier: music.bundle,
            }
          : { processes: [music] }),
  })
  const dispose = await plugin.setup({
    ui: {
      slot(claim: { append: string; render: () => unknown }) {
        if (claim.append === "app") claim.render()
        return () => {}
      },
      dialog: {
        select: async () => {
          selections++
          return "auto"
        },
        confirm: async () => true,
      },
      toast: {
        show(input: { message: string }) {
          errors.push(input.message)
        },
      },
    },
    keymap: {
      layer(
        factory: () => { commands: { id: string; run: () => Promise<void> }[] },
      ) {
        for (const command of factory().commands)
          handlers.set(command.id, command.run)
      },
    },
  } as unknown as Plugin.Context)
  return {
    run(name: string) {
      return handlers.get(`audio-prototype.${name}`)!()
    },
    dispose: async () => {
      await dispose?.()
    },
    errors,
    selections: () => selections,
  }
}

for (const reentry of ["dispose", "stop", "source"] as const) {
  test(`reentrant ${reentry} owns a newly returned child until exit and both pipe cleanups join`, async () => {
    const capture = gatedChild()
    const spawned = deferred<void>()
    let app!: Awaited<ReturnType<typeof fixture>>
    let retiring: Promise<void> | undefined
    let joined = false
    app = await fixture(() => {
      retiring = (
        reentry === "dispose" ? app.dispose() : app.run(reentry)
      ).then(() => {
        joined = true
      })
      spawned.resolve()
      return capture.child
    })
    await app.run("source")
    const timers = spyOn(globalThis, "setTimeout")
    const starting = app.run("start")
    try {
      await spawned.promise
      await turn()
      expect(capture.events[0]).toBe("SIGTERM")
      expect(joined).toBe(false)
      expect(app.selections()).toBe(1)
      capture.exit.resolve(0)
      await turn()
      expect(joined).toBe(false)
      expect(capture.child.stdout.locked).toBe(true)
      expect(capture.child.stderr.locked).toBe(true)
      capture.cleanup.resolve()
      await Promise.all([starting, retiring])
      expect(joined).toBe(true)
      expect(capture.child.stdout.locked).toBe(false)
      expect(capture.child.stderr.locked).toBe(false)
      expect(
        timers.mock.calls.some(
          (args) => args[1] === 31_000 || args[1] === 33_000,
        ),
      ).toBe(false)
      expect(app.errors).toEqual([])
    } finally {
      timers.mockRestore()
      capture.release()
      await Promise.allSettled([starting, retiring])
      await app.dispose()
    }
  })
}

test("reentrant disposal during reader acquisition joins capture work before publishing its task pointer", async () => {
  const capture = gatedChild()
  const app = await fixture(() => capture.child)
  await app.run("source")
  const getReader = capture.child.stdout.getReader.bind(capture.child.stdout)
  let joined = false
  let disposing: Promise<void> | undefined
  const acquire = spyOn(capture.child.stdout, "getReader").mockImplementation(
    () => {
      const reader = getReader()
      disposing = app.dispose().then(() => {
        joined = true
      })
      return reader
    },
  )
  const starting = app.run("start")
  try {
    await turn()
    capture.exit.resolve(0)
    await turn()
    expect(joined).toBe(false)
    expect(capture.child.stdout.locked).toBe(true)
    capture.cleanup.resolve()
    await Promise.all([starting, disposing])
    expect(joined).toBe(true)
    expect(capture.child.stdout.locked).toBe(false)
    expect(capture.child.stderr.locked).toBe(false)
  } finally {
    acquire.mockRestore()
    capture.release()
    await Promise.allSettled([starting, disposing])
    await app.dispose()
  }
})

test("abort joins the first cancellation promise and retains the reader lock until it settles", async () => {
  const cleanup = deferred<void>()
  let calls = 0
  const source = new ReadableStream<Uint8Array>({
    cancel() {
      calls++
      return cleanup.promise
    },
  })
  const controller = new AbortController()
  let settled = false
  const draining = drainDiagnostics(source, controller.signal).then(() => {
    settled = true
  })
  controller.abort()
  controller.abort()
  try {
    await turn()
    expect(calls).toBe(1)
    expect(settled).toBe(false)
    expect(source.locked).toBe(true)
    cleanup.resolve()
    await draining
    expect(source.locked).toBe(false)
  } finally {
    cleanup.resolve()
    await draining
  }
})

test("rejected cancellation fails truthfully without exposing the private rejection", async () => {
  const source = new ReadableStream<Uint8Array>({
    cancel() {
      return Promise.reject(new Error("/private/SECRET_CANCEL"))
    },
  })
  const controller = new AbortController()
  const draining = drainDiagnostics(source, controller.signal)
  controller.abort()
  const error = await draining.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(error).toBeInstanceOf(Error)
  expect(error instanceof Error ? error.message : undefined).toBe(
    "Source reader cleanup failed",
  )
  expect(source.locked).toBe(false)
})

test("a synchronous reader cancellation throw produces a sanitized cleanup failure", async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })
  const getReader = source.getReader.bind(source)
  const acquire = spyOn(source, "getReader").mockImplementation(() => {
    const reader = getReader()
    spyOn(reader, "cancel").mockImplementation(() => {
      throw new Error("/private/SECRET_SYNC_CANCEL")
    })
    return reader
  })
  try {
    const error = await drainDiagnostics(source).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error instanceof Error ? error.message : undefined).toBe(
      "Source reader cleanup failed",
    )
    expect(source.locked).toBe(false)
  } finally {
    acquire.mockRestore()
  }
})

test("a synchronous abort cancellation throw cannot leave the consumer blocked forever", async () => {
  const source = new ReadableStream<Uint8Array>()
  const getReader = source.getReader.bind(source)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const acquire = spyOn(source, "getReader").mockImplementation(() => {
    reader = getReader()
    spyOn(reader, "cancel").mockImplementation(() => {
      throw new Error("/private/SECRET_SYNC_ABORT")
    })
    return reader
  })
  const controller = new AbortController()
  let settled = false
  const draining = drainDiagnostics(source, controller.signal).then(
    () => {
      settled = true
      return undefined
    },
    (error: unknown) => {
      settled = true
      return error
    },
  )
  try {
    controller.abort()
    await turn()
    expect(settled).toBe(true)
    const error = await draining
    expect(error instanceof Error ? error.message : undefined).toBe(
      "Source reader cleanup failed",
    )
    expect(source.locked).toBe(false)
  } finally {
    reader?.releaseLock()
    await draining
    acquire.mockRestore()
  }
})

for (const reentrant of [false, true]) {
  test(`${reentrant ? "unpublished" : "active"} capture cleanup failure rejects disposal only after child exit and reader settlement`, async () => {
    const capture = gatedChild()
    const spawned = deferred<void>()
    let app!: Awaited<ReturnType<typeof fixture>>
    let disposal: Promise<unknown> | undefined
    let settled = false
    const dispose = () =>
      app.dispose().then(
        () => {
          settled = true
          return undefined
        },
        (error: unknown) => {
          settled = true
          return error
        },
      )
    app = await fixture(() => {
      if (reentrant) disposal = dispose()
      spawned.resolve()
      return capture.child
    })
    await app.run("source")
    const starting = app.run("start")
    try {
      await spawned.promise
      if (!reentrant) {
        await starting
        disposal = dispose()
      }
      await turn()
      capture.cleanup.reject(new Error("/private/SECRET_CHILD_CLEANUP"))
      await turn()
      expect(settled).toBe(false)
      capture.exit.resolve(0)
      await starting
      const error = await disposal
      expect(error).toBeInstanceOf(Error)
      expect(error instanceof Error ? error.message : undefined).toBe(
        "Audio prototype cleanup failed",
      )
      expect(capture.child.stdout.locked).toBe(false)
      expect(capture.child.stderr.locked).toBe(false)
      expect(app.errors).toEqual([])
    } finally {
      capture.release()
      await Promise.allSettled([starting, disposal])
    }
  })
}

test("abort plus callback failure cancels once and joins cleanup before reporting validation failure", async () => {
  const cleanup = deferred<void>()
  const controller = new AbortController()
  let cancellations = 0
  let settled = false
  const source = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode("frame\n"))
    },
    cancel() {
      cancellations++
      return cleanup.promise
    },
  })
  const consuming = consumeFeatureLines(
    source,
    () => {
      controller.abort()
      throw new Error("/private/SECRET_CALLBACK")
    },
    controller.signal,
  ).then(
    () => {
      settled = true
      return undefined
    },
    (error: unknown) => {
      settled = true
      return error
    },
  )
  try {
    await turn()
    expect(settled).toBe(false)
    expect(cancellations).toBe(1)
    expect(source.locked).toBe(true)
    cleanup.resolve()
    const error = await consuming
    expect(error instanceof Error ? error.message : undefined).toBe(
      "Source output was invalid or could not be read",
    )
    expect(source.locked).toBe(false)
  } finally {
    cleanup.resolve()
    await consuming
  }
})

test("aborting from a feature callback prevents the rest of the same chunk from being published", async () => {
  const controller = new AbortController()
  const published: string[] = []
  const source = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(
        new TextEncoder().encode("first\n" + "late\n".repeat(20_000)),
      )
    },
  })
  await consumeFeatureLines(
    source,
    (line) => {
      published.push(line)
      controller.abort()
    },
    controller.signal,
  )
  expect(published).toHaveLength(1)
  expect(published[0]).toBe("first")
  expect(source.locked).toBe(false)
})

test("metadata process cancellation preserves a failed cleanup outcome instead of treating it as benign abort", async () => {
  const capture = gatedChild()
  const spawn = spyOn(Bun, "spawn").mockReturnValue(
    capture.child as unknown as ReturnType<typeof Bun.spawn>,
  )
  const controller = new AbortController()
  let settled = false
  const reading = readProcessOutput(["synthetic-metadata"], {
    signal: controller.signal,
  }).then(
    () => {
      settled = true
      return undefined
    },
    (error: unknown) => {
      settled = true
      return error
    },
  )
  try {
    controller.abort()
    capture.cleanup.reject(new Error("/private/SECRET_METADATA_CANCEL"))
    await turn()
    expect(settled).toBe(false)
    capture.exit.resolve(0)
    const error = await reading
    expect(error).toBeInstanceOf(ReaderCleanupError)
    expect(error instanceof Error ? error.message : undefined).toBe(
      "Source reader cleanup failed",
    )
  } finally {
    capture.release()
    await reading
    spawn.mockRestore()
  }
})

test("disposal joins an owned metadata cleanup failure and rejects with a fixed message", async () => {
  const entered = deferred<void>()
  const app = await fixture(
    () => {
      throw new Error("Unexpected capture")
    },
    (_, signal) =>
      new Promise((_, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new ReaderCleanupError()),
          { once: true },
        )
        entered.resolve()
      }),
  )
  const selecting = app.run("source")
  await entered.promise
  const error = await app.dispose().then(
    () => undefined,
    (error: unknown) => error,
  )
  await selecting
  expect(error instanceof Error ? error.message : undefined).toBe(
    "Audio prototype cleanup failed",
  )
  expect(app.selections()).toBe(0)
  expect(app.errors).toEqual([])
})

test("a throwing termination cannot release disposal before exit and reader cleanup join", async () => {
  const capture = gatedChild()
  const kill = spyOn(capture.child, "kill").mockImplementation(() => {
    throw new Error("/private/SECRET_TERMINATION")
  })
  const app = await fixture(() => capture.child)
  await app.run("source")
  await app.run("start")
  let settled = false
  const disposing = app.dispose().then(
    () => {
      settled = true
      return undefined
    },
    (error: unknown) => {
      settled = true
      return error
    },
  )
  try {
    await turn()
    expect(settled).toBe(false)
    expect(capture.child.stdout.locked).toBe(true)
    expect(capture.child.stderr.locked).toBe(true)
    capture.exit.resolve(0)
    await turn()
    expect(settled).toBe(false)
    capture.cleanup.resolve()
    const error = await disposing
    expect(error instanceof Error ? error.message : undefined).toBe(
      "Audio prototype cleanup failed",
    )
    expect(capture.child.stdout.locked).toBe(false)
    expect(capture.child.stderr.locked).toBe(false)
    expect(app.errors).toEqual([])
  } finally {
    capture.release()
    await disposing
    kill.mockRestore()
  }
})

test("termination failure after EOF clears capture timers and never exposes a private error", async () => {
  const capture = gatedChild()
  const kill = spyOn(capture.child, "kill").mockImplementation(() => {
    throw new Error("/private/SECRET_FINALLY_KILL")
  })
  const timers = spyOn(globalThis, "setTimeout")
  const cleared = spyOn(globalThis, "clearTimeout")
  const app = await fixture(() => capture.child)
  let disposing: Promise<unknown> | undefined
  try {
    await app.run("source")
    await app.run("start")
    const captureTimers = timers.mock.calls.flatMap((args, index) =>
      args[1] === 31_000 || args[1] === 33_000
        ? [timers.mock.results[index]!.value]
        : [],
    )
    expect(captureTimers).toHaveLength(2)
    capture.release()
    await turn()
    disposing = app.dispose().then(
      () => undefined,
      (error: unknown) => error,
    )
    const error = await disposing
    expect(error instanceof Error ? error.message : undefined).toBe(
      "Audio prototype cleanup failed",
    )
    for (const timer of captureTimers)
      expect(cleared.mock.calls.some((args) => args[0] === timer)).toBe(true)
    expect(app.errors.some((message) => message.includes("SECRET"))).toBe(false)
    expect(capture.child.stdout.locked).toBe(false)
    expect(capture.child.stderr.locked).toBe(false)
  } finally {
    // Clear test-observed handles even on RED; a failing cleanup must not stall the test runner.
    for (const result of timers.mock.results)
      if (result.type === "return") clearTimeout(result.value)
    capture.release()
    if (disposing) await disposing
    else await app.dispose().catch(() => {})
    kill.mockRestore()
    timers.mockRestore()
    cleared.mockRestore()
  }
})

test("active child-exit rejection stays visible after disposal joins both readers", async () => {
  const capture = gatedChild()
  const app = await fixture(() => capture.child)
  await app.run("source")
  await app.run("start")
  let settled = false
  const disposing = app.dispose().then(
    () => {
      settled = true
      return undefined
    },
    (error: unknown) => {
      settled = true
      return error
    },
  )
  try {
    capture.exit.reject(new Error("/private/SECRET_EXIT"))
    await turn()
    expect(settled).toBe(false)
    capture.cleanup.resolve()
    const error = await disposing
    expect(error instanceof Error ? error.message : undefined).toBe(
      "Audio prototype cleanup failed",
    )
    expect(capture.child.stdout.locked).toBe(false)
    expect(capture.child.stderr.locked).toBe(false)
    expect(app.errors).toEqual([])
  } finally {
    capture.release()
    await disposing
  }
})
