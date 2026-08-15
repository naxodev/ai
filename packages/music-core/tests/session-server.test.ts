import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chmod, lstat, mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import net from "node:net"
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Queue,
  Ref,
  Scope,
} from "effect"
import {
  layer as configLayer,
  prepareManagedRuntimeDirectory,
  resolveMusicSessionRuntimePaths,
} from "../session/config.ts"
import {
  createFakeProvider,
  layerFromLegacy,
  makeCoordinatorProviderFixture,
  type CoordinatorProviderFixture,
} from "../session/provider.ts"
import {
  layerWithHooks,
  MusicSessionServerService,
  startMusicSessionServer,
} from "../session/server.ts"
import { createMusicSessionClient } from "../session/client.ts"
import {
  runMusicSessionDaemon,
  waitForSignal,
} from "../session/music-sessiond.ts"
import { NdjsonFramer } from "../session/framing.ts"
import { LEGACY_PROTOCOL, PROTOCOL } from "../session/protocol.ts"

const socketPath = (name: string) =>
  `/tmp/music-session-${name}-${process.pid}-${randomUUID()}.sock`

const readUntil = async (stream: ReadableStream<Uint8Array>, text: string) => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ""
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) throw new Error(`daemon exited before writing ${text}`)
      output += decoder.decode(next.value, { stream: true })
      if (output.includes(text)) return output
    }
  } finally {
    reader.releaseLock()
  }
}

const connected = (path: string) => {
  const socket = net.createConnection(path)
  return new Promise<net.Socket>((resolve, reject) => {
    const remove = () => {
      socket.off("connect", onConnect)
      socket.off("error", onError)
    }
    const onConnect = () => {
      remove()
      resolve(socket)
    }
    const onError = (cause: Error) => {
      remove()
      socket.destroy()
      reject(cause)
    }
    socket.once("connect", onConnect)
    socket.once("error", onError)
  })
}

const frameReader = (socket: net.Socket) => {
  const framer = new NdjsonFramer()
  const frames: Array<Record<string, unknown>> = []
  const received: Array<Record<string, unknown>> = []
  const waiters: Array<{
    predicate: (frame: Record<string, unknown>) => boolean
    resolve: (frame: Record<string, unknown>) => void
    reject: (cause: unknown) => void
  }> = []
  let terminal: unknown
  const remove = () => {
    socket.off("data", onData)
    socket.off("error", finish)
    socket.off("end", onEnd)
    socket.off("close", onClose)
  }
  const finish = (cause: unknown) => {
    if (terminal !== undefined) return
    terminal = cause
    remove()
    for (const waiter of waiters.splice(0)) waiter.reject(cause)
  }
  const onData = (chunk: Buffer) => {
    try {
      for (const frame of framer.push(chunk) as Array<
        Record<string, unknown>
      >) {
        received.push(frame)
        const index = waiters.findIndex((waiter) => waiter.predicate(frame))
        if (index < 0) frames.push(frame)
        else waiters.splice(index, 1)[0]!.resolve(frame)
      }
    } catch (cause) {
      finish(cause)
    }
  }
  const onEnd = () => {
    try {
      framer.end()
      finish(new Error("socket ended before expected frame"))
    } catch (cause) {
      finish(cause)
    }
  }
  const onClose = () => finish(new Error("socket closed before expected frame"))
  socket.on("data", onData)
  socket.on("error", finish)
  socket.on("end", onEnd)
  socket.on("close", onClose)
  return {
    next: (predicate: (frame: Record<string, unknown>) => boolean) => {
      const index = frames.findIndex(predicate)
      if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]!)
      if (terminal !== undefined) return Promise.reject(terminal)
      return new Promise<Record<string, unknown>>((resolve, reject) =>
        waiters.push({ predicate, resolve, reject }),
      )
    },
    dispose: () => finish(new Error("reader disposed")),
    received,
  }
}

test("managed server owns only its bound owner-only socket", async () => {
  const root = await mkdtemp("/tmp/music-session-managed-server-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  try {
    server = await startMusicSessionServer({ runtime }, createFakeProvider())
    const directory = await lstat(runtime.directory)
    const socket = await lstat(runtime.socketPath)
    expect(directory.mode & 0o077).toBe(0)
    expect(socket.isSocket()).toBe(true)
    expect(socket.mode & 0o077).toBe(0)
    const neighbor = `${runtime.directory}/unrelated`
    await writeFile(neighbor, "keep")
    await server.close()
    expect(existsSync(runtime.socketPath)).toBe(false)
    expect(existsSync(runtime.directory)).toBe(true)
    expect(existsSync(neighbor)).toBe(true)
    server = undefined
  } finally {
    await server?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("post-bind hardening failure closes and removes only the partial managed socket", async () => {
  const root = await mkdtemp("/tmp/music-session-managed-harden-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  let closed = false
  const provider = createFakeProvider()
  try {
    const neighbor = `${runtime.directory}/unrelated`
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    await writeFile(neighbor, "keep")
    await expect(
      startMusicSessionServer({ runtime }, provider, {
        onPartialBound: () => {
          throw new Error("injected hardening failure")
        },
        onClose: () => {
          closed = true
        },
      }),
    ).rejects.toMatchObject({ operation: "harden" })
    expect(closed).toBe(true)
    expect(existsSync(runtime.socketPath)).toBe(false)
    expect(existsSync(runtime.directory)).toBe(true)
    expect(existsSync(neighbor)).toBe(true)
    // Listener hardening failed before provider ownership could be acquired.
    expect(provider.counts.providerDisposals).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("second managed server leaves the first endpoint unchanged and connectable", async () => {
  const root = await mkdtemp("/tmp/music-session-managed-second-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  let owner: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    owner = await startMusicSessionServer({ runtime }, createFakeProvider())
    const before = await lstat(runtime.socketPath)
    await expect(
      startMusicSessionServer({ runtime }, createFakeProvider()),
    ).rejects.toMatchObject({ operation: "listen" })
    const after = await lstat(runtime.socketPath)
    expect([after.dev, after.ino, after.mode & 0o777]).toEqual([
      before.dev,
      before.ino,
      before.mode & 0o777,
    ])
    client = await createMusicSessionClient({
      socketPath: runtime.socketPath,
      clientId: "second-server-check",
      hostKind: "test",
    })
    expect(client.daemonInstanceId).not.toBe("")
  } finally {
    client?.dispose()
    await owner?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("managed shutdown retains a replacement bound path", async () => {
  const root = await mkdtemp("/tmp/music-session-managed-replacement-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  try {
    server = await startMusicSessionServer({ runtime }, createFakeProvider())
    await unlink(runtime.socketPath)
    await writeFile(runtime.socketPath, "replacement")
    await expect(server.close()).rejects.toMatchObject({ operation: "unlink" })
    server = undefined
    expect(await lstat(runtime.socketPath)).toMatchObject({ size: 11 })
  } finally {
    await server?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("legacy and current peers share replay and live updates", async () => {
  const path = socketPath("negotiation")
  const provider = createFakeProvider()
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let current: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  let legacy: net.Socket | undefined
  let legacyFrames: ReturnType<typeof frameReader> | undefined
  try {
    server = await startMusicSessionServer({ socketPath: path }, provider)
    current = await createMusicSessionClient({
      socketPath: path,
      clientId: "current",
      hostKind: "test",
    })
    legacy = await connected(path)
    legacyFrames = frameReader(legacy)
    legacy.write(
      `${JSON.stringify({
        type: "hello",
        requestId: 0,
        protocol: LEGACY_PROTOCOL,
        packageVersion: "old",
        clientId: "legacy",
        hostKind: "test",
        capabilities: ["state-replay"],
      })}\n`,
    )
    const hello = await legacyFrames.next(
      (frame) => frame.type === "response" && frame.requestId === 0,
    )
    expect(hello).toMatchObject({
      ok: true,
      data: { protocol: LEGACY_PROTOCOL },
    })
    expect(current.daemonInstanceId).toBe(
      (hello?.data as { daemonInstanceId: string }).daemonInstanceId,
    )
    expect(provider.counts.subscriptions).toBe(1)
    expect(
      await legacyFrames.next((frame) => frame.type === "state"),
    ).toMatchObject({
      snapshot: { daemonInstanceId: current.daemonInstanceId },
    })
    expect(current.state?.daemonInstanceId).toBe(current.daemonInstanceId)
    const currentUpdate = new Promise<void>((resolve) => {
      const unsubscribe = current!.subscribeState((snapshot) => {
        if (snapshot.revision > 0) {
          unsubscribe()
          resolve()
        }
      })
    })
    provider.emit({
      type: "snapshot",
      state: { ...provider.state, fetched_at: 1 },
    })
    expect(
      await legacyFrames.next((frame) => frame.type === "state"),
    ).toMatchObject({
      snapshot: { daemonInstanceId: current.daemonInstanceId },
    })
    await currentUpdate
  } finally {
    legacyFrames?.dispose()
    legacy?.destroy()
    current?.dispose()
    await server?.close().catch(() => {})
  }
})

test("incompatible and state-only peers do not disturb a healthy session", async () => {
  const path = socketPath("capabilities")
  let admissions = 0
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let current: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  let incompatible: net.Socket | undefined
  let incompatibleFrames: ReturnType<typeof frameReader> | undefined
  let stateOnly: net.Socket | undefined
  let stateOnlyFrames: ReturnType<typeof frameReader> | undefined
  let beforeHello: net.Socket | undefined
  let beforeHelloFrames: ReturnType<typeof frameReader> | undefined
  let invalidHello: net.Socket | undefined
  let invalidHelloFrames: ReturnType<typeof frameReader> | undefined
  let missingReplay: net.Socket | undefined
  let missingReplayFrames: ReturnType<typeof frameReader> | undefined
  let oversized: net.Socket | undefined
  try {
    server = await startMusicSessionServer(
      { socketPath: path, maxFrameBytes: 4096 },
      undefined,
      {
        onCommandAdmission: () => admissions++,
      },
    )
    current = await createMusicSessionClient({
      socketPath: path,
      clientId: "healthy",
      hostKind: "test",
    })
    incompatible = await connected(path)
    incompatibleFrames = frameReader(incompatible)
    const incompatibleClosed = new Promise<void>((resolve) =>
      incompatible!.once("close", resolve),
    )
    incompatible.write(
      `${JSON.stringify({
        type: "hello",
        requestId: 0,
        protocol: { major: PROTOCOL.major, minRevision: 2, maxRevision: 3 },
        packageVersion: "future",
        clientId: "future",
        hostKind: "test",
        capabilities: ["state-replay"],
      })}\n`,
    )
    const incompatibility = await incompatibleFrames.next(
      (frame) => frame.type === "response" && frame.requestId === 0,
    )
    expect(incompatibility).toMatchObject({
      ok: false,
      error: {
        code: "INCOMPATIBLE_PROTOCOL",
        details: {
          client: { major: PROTOCOL.major, minRevision: 2, maxRevision: 3 },
          daemon: PROTOCOL,
        },
      },
    })
    expect((incompatibility.error as { message: string }).message).toContain(
      "protocol range",
    )
    await incompatibleClosed
    expect(
      incompatibleFrames.received.filter(
        (frame) => frame.type === "response" && frame.requestId === 0,
      ),
    ).toHaveLength(1)
    await current.play()
    expect(admissions).toBe(1)

    beforeHello = await connected(path)
    beforeHelloFrames = frameReader(beforeHello)
    const beforeHelloClosed = new Promise<void>((resolve) =>
      beforeHello!.once("close", resolve),
    )
    beforeHello.write(`${JSON.stringify({ type: "state", requestId: 0 })}\n`)
    expect(
      await beforeHelloFrames.next(
        (frame) => frame.type === "response" && frame.requestId === 0,
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } })
    await beforeHelloClosed

    invalidHello = await connected(path)
    invalidHelloFrames = frameReader(invalidHello)
    invalidHello.write(
      `${JSON.stringify({
        type: "hello",
        requestId: 0,
        protocol: { major: PROTOCOL.major, minRevision: 2, maxRevision: 1 },
        packageVersion: "bad",
        clientId: "bad-range",
        hostKind: "test",
        capabilities: ["state-replay"],
      })}\n`,
    )
    expect(
      await invalidHelloFrames.next(
        (frame) => frame.type === "response" && frame.requestId === 0,
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } })

    missingReplay = await connected(path)
    missingReplayFrames = frameReader(missingReplay)
    missingReplay.write(
      `${JSON.stringify({
        type: "hello",
        requestId: 0,
        protocol: PROTOCOL,
        packageVersion: "current",
        clientId: "missing-replay",
        hostKind: "test",
        capabilities: ["transport"],
      })}\n`,
    )
    expect(
      await missingReplayFrames.next(
        (frame) => frame.type === "response" && frame.requestId === 0,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_CAPABILITY" },
    })

    stateOnly = await connected(path)
    stateOnlyFrames = frameReader(stateOnly)
    stateOnly.write(
      `${JSON.stringify({
        type: "hello",
        requestId: 0,
        protocol: PROTOCOL,
        packageVersion: "current",
        clientId: "state-only",
        hostKind: "test",
        capabilities: ["state-replay"],
      })}\n`,
    )
    expect(
      await stateOnlyFrames.next(
        (frame) => frame.type === "response" && frame.requestId === 0,
      ),
    ).toMatchObject({ ok: true, data: { capabilities: ["state-replay"] } })
    const rejectedTransport = stateOnlyFrames.next(
      (frame) => frame.type === "response" && frame.requestId === 1,
    )
    stateOnly.write(
      `${JSON.stringify({ type: "transport", requestId: 1, action: "play" })}\n`,
    )
    expect(await rejectedTransport).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_CAPABILITY" },
    })
    const secondHello = stateOnlyFrames.next(
      (frame) => frame.type === "response" && frame.requestId === 2,
    )
    stateOnly.write(
      `${JSON.stringify({
        type: "hello",
        requestId: 2,
        protocol: PROTOCOL,
        packageVersion: "current",
        clientId: "state-only",
        hostKind: "test",
        capabilities: ["state-replay"],
      })}\n`,
    )
    expect(await secondHello).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    })
    for (const [requestId, request, code] of [
      [2, { type: "state" }, "DUPLICATE_REQUEST_ID"],
      [3, { type: "transport", action: "invalid" }, "UNSUPPORTED_ACTION"],
      [
        4,
        { type: "transport", action: "seek", positionMs: -1 },
        "INVALID_SEEK",
      ],
    ] as const) {
      const result = stateOnlyFrames.next(
        (frame) => frame.type === "response" && frame.requestId === requestId,
      )
      stateOnly.write(`${JSON.stringify({ ...request, requestId })}\n`)
      expect(await result).toMatchObject({ ok: false, error: { code } })
    }
    expect(admissions).toBe(1)
    const negotiatedEof = new Promise<void>((resolve) =>
      stateOnly!.once("close", resolve),
    )
    stateOnly.write('{"type":"state"')
    stateOnly.end()
    await negotiatedEof
    await current.play()
    expect(admissions).toBe(2)

    oversized = await connected(path)
    const oversizedClosed = new Promise<void>((resolve) =>
      oversized!.once("close", resolve),
    )
    oversized.write(Buffer.alloc(4097, 0x78))
    await oversizedClosed
    await current.play()
    expect(admissions).toBe(3)
  } finally {
    incompatibleFrames?.dispose()
    stateOnlyFrames?.dispose()
    beforeHelloFrames?.dispose()
    invalidHelloFrames?.dispose()
    missingReplayFrames?.dispose()
    incompatible?.destroy()
    stateOnly?.destroy()
    beforeHello?.destroy()
    invalidHello?.destroy()
    missingReplay?.destroy()
    oversized?.destroy()
    current?.dispose()
    await server?.close().catch(() => {})
  }
})

test("scoped signal wait removes both handlers after a signal", async () => {
  const signals = new EventEmitter()
  let closeScope: (() => Promise<void>) | undefined
  try {
    const scope = await Effect.runPromise(Scope.make())
    closeScope = () => Effect.runPromise(Scope.close(scope, Exit.void))
    const waiting = await Effect.runPromise(
      Effect.forkIn(scope, { startImmediately: true })(waitForSignal(signals)),
    )
    expect(signals.listenerCount("SIGINT")).toBe(1)
    expect(signals.listenerCount("SIGTERM")).toBe(1)
    signals.emit("SIGINT")
    await Effect.runPromise(Fiber.join(waiting))
    expect(signals.listenerCount("SIGINT")).toBe(0)
    expect(signals.listenerCount("SIGTERM")).toBe(0)
  } finally {
    await closeScope?.()
  }
})

test("scoped signal wait removes both handlers on interruption", async () => {
  const signals = new EventEmitter()
  let closeScope: (() => Promise<void>) | undefined
  try {
    const scope = await Effect.runPromise(Scope.make())
    closeScope = () => Effect.runPromise(Scope.close(scope, Exit.void))
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.forkIn(scope, { startImmediately: true })(
          waitForSignal(signals),
        )
        expect(signals.listenerCount("SIGINT")).toBe(1)
        expect(signals.listenerCount("SIGTERM")).toBe(1)
      }),
    )
  } finally {
    await closeScope?.()
  }
  expect(signals.listenerCount("SIGINT")).toBe(0)
  expect(signals.listenerCount("SIGTERM")).toBe(0)
})

test("server shutdown exactly finalizes a pre-hello connection and graph", async () => {
  const path = socketPath("stalled")
  const provider = createFakeProvider()
  const counts = {
    coordinator: 0,
    listener: 0,
    listenerFinalized: 0,
    input: 0,
    connection: 0,
  }
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let socket: net.Socket | undefined
  try {
    server = await startMusicSessionServer({ socketPath: path }, provider, {
      onCoordinator: () => {
        counts.coordinator += 1
      },
      onListener: () => {
        counts.listener += 1
      },
      onListenerFinalized: () => {
        counts.listenerFinalized += 1
      },
      onInputFinalized: () => {
        counts.input += 1
      },
      onConnectionFinalized: () => {
        counts.connection += 1
      },
    })
    socket = await connected(path)
    await server.close()
    await server.close()
    expect(socket.destroyed).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(counts).toEqual({
      coordinator: 1,
      listener: 1,
      listenerFinalized: 1,
      input: 1,
      connection: 1,
    })
    expect(provider.counts.disposals).toBe(1)
    expect(provider.counts.providerDisposals).toBe(1)
  } finally {
    socket?.destroy()
    await server?.close().catch(() => {})
  }
})

test("server close interrupts post-hello forwarding before late provider events", async () => {
  const path = socketPath("active")
  const provider = createFakeProvider()
  let writes = 0
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    server = await startMusicSessionServer({ socketPath: path }, provider, {
      onWriteAttempt: () => {
        writes += 1
      },
    })
    client = await createMusicSessionClient({
      socketPath: path,
      clientId: "active-client",
      hostKind: "test",
    })
    await server.close()
    const writesBeforeLateEvent = writes
    provider.emit({
      type: "snapshot",
      state: { ...provider.state, fetched_at: 2 },
    })
    await Promise.resolve()
    expect(writes).toBe(writesBeforeLateEvent)
    expect(provider.counts.disposals).toBe(1)
    expect(provider.counts.providerDisposals).toBe(1)
    expect(existsSync(path)).toBe(false)
  } finally {
    client?.dispose()
    await server?.close().catch(() => {})
  }
})

test("partial-frame disconnect exactly finalizes input and connection while listener stays healthy", async () => {
  const path = socketPath("mid-frame")
  let inputs = 0
  let processors = 0
  let connections = 0
  let eofProcessed = 0
  let resolveFinalized: () => void = () => {}
  const finalized = new Promise<void>((resolve) => {
    resolveFinalized = resolve
  })
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let partial: net.Socket | undefined
  let healthy: net.Socket | undefined
  try {
    server = await startMusicSessionServer({ socketPath: path }, undefined, {
      onInputFinalized: () => {
        inputs += 1
      },
      onInputProcessorFinalized: () => {
        processors += 1
      },
      onInputEof: () => {
        eofProcessed += 1
      },
      onConnectionFinalized: () => {
        connections += 1
        resolveFinalized()
      },
    })
    const partialSocket = await connected(path)
    partial = partialSocket
    const closed = new Promise<void>((resolve) =>
      partialSocket.once("close", resolve),
    )
    partialSocket.write('{"type":"hello"')
    partialSocket.end()
    await closed
    await finalized
    // EOF is processed by the serial input fiber before its finalization.
    expect(eofProcessed).toBe(1)
    expect(inputs).toBe(1)
    expect(processors).toBe(1)
    expect(connections).toBe(1)
    healthy = await connected(path)
    healthy.destroy()
  } finally {
    partial?.destroy()
    healthy?.destroy()
    await server?.close().catch(() => {})
  }
})

test("natural malformed-client disconnect leaves the listener healthy", async () => {
  const path = socketPath("mid-frame")
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let partial: net.Socket | undefined
  let healthy: net.Socket | undefined
  try {
    const activeServer = await startMusicSessionServer({ socketPath: path })
    server = activeServer
    partial = await connected(path)
    const closed = new Promise<void>((resolve) =>
      partial?.once("close", resolve),
    )
    partial.write('{"type":"hello"')
    partial.end()
    await closed
    healthy = await connected(path)
    healthy.destroy()
    await activeServer.close()
    expect(existsSync(path)).toBe(false)
  } finally {
    partial?.destroy()
    healthy?.destroy()
    await server?.close().catch(() => {})
  }
})

test("correlates an invalid request without closing the listener", async () => {
  const path = socketPath("invalid")
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let socket: net.Socket | undefined
  try {
    server = await startMusicSessionServer(
      { socketPath: path },
      createFakeProvider(),
    )
    socket = await connected(path)
    const response = new Promise<string>((resolve) =>
      socket?.once("data", (chunk: Buffer) => resolve(chunk.toString())),
    )
    socket.write('{"type":"transport","requestId":7,"action":"unknown"}\n')
    expect(JSON.parse(await response)).toMatchObject({
      type: "response",
      requestId: 7,
      ok: false,
      error: { code: "UNSUPPORTED_ACTION" },
    })
  } finally {
    socket?.destroy()
    await server?.close().catch(() => {})
  }
})

test("socket defects are observed while a healthy peer remains live", async () => {
  const path = socketPath("socket-defect")
  const failures: unknown[] = []
  const accepted: net.Socket[] = []
  const provider = createFakeProvider()
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let broken: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  let healthy: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    server = await startMusicSessionServer({ socketPath: path }, provider, {
      onAccepted: (socket) => accepted.push(socket),
      onConnectionFailure: (cause) => failures.push(cause),
    })
    broken = await createMusicSessionClient({
      socketPath: path,
      clientId: "broken",
      hostKind: "test",
    })
    healthy = await createMusicSessionClient({
      socketPath: path,
      clientId: "healthy",
      hostKind: "test",
    })
    expect(accepted).toHaveLength(2)
    accepted[0]?.emit("error", new Error("injected socket defect"))
    expect(failures).toHaveLength(1)
    expect((failures[0] as Error).message).toBe("injected socket defect")
    const update = new Promise<void>((resolve) =>
      healthy?.subscribeState((snapshot) => {
        if (snapshot.state.progress_ms === 99) resolve()
      }),
    )
    provider.emit({
      type: "snapshot",
      state: { ...provider.state, progress_ms: 99, fetched_at: 99 },
    })
    await update
    expect(healthy.state?.state.progress_ms).toBe(99)
  } finally {
    broken?.dispose()
    healthy?.dispose()
    await server?.close().catch(() => {})
  }
})

test("throwing enrollment seam still destroys the accepted socket", async () => {
  const path = socketPath("acceptance-hook-throw")
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let socket: net.Socket | undefined
  try {
    server = await startMusicSessionServer(
      { socketPath: path },
      createFakeProvider(),
      {
        canEnroll: () => {
          throw new Error("injected enrollment hook fault")
        },
      },
    )
    socket = net.createConnection(path)
    await new Promise<void>((resolve) => socket?.once("close", resolve))
    expect(socket.destroyed).toBe(true)
  } finally {
    socket?.destroy()
    await server?.close().catch(() => {})
  }
})

test("acceptance during actual server shutdown is enrolled then finalized", async () => {
  const path = socketPath("acceptance-shutdown")
  let accepted = 0
  let enrolled = 0
  let finalized = 0
  let closing: Promise<void> | undefined
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let socket: net.Socket | undefined
  try {
    server = await startMusicSessionServer(
      { socketPath: path },
      createFakeProvider(),
      {
        onNodeConnection: () => {
          if (server) closing ??= server.close()
        },
        onAccepted: () => {
          accepted += 1
        },
        onEnrolled: () => {
          enrolled += 1
        },
        onConnectionFinalized: () => {
          finalized += 1
        },
      },
    )
    socket = net.createConnection(path)
    await new Promise<void>((resolve) => socket?.once("close", resolve))
    await closing
    // Shutdown begins in the real Node acceptance callback. The callback either
    // sees closing and destroys, or enrolls before shutdown drains the child.
    expect(accepted === 0 || (accepted === 1 && enrolled === 1)).toBe(true)
    expect(finalized).toBe(enrolled)
    expect(socket.destroyed).toBe(true)
    expect(existsSync(path)).toBe(false)
  } finally {
    socket?.destroy()
    await server?.close().catch(() => {})
  }
})

test("production closing refusal destroys a real listener connection", async () => {
  const path = socketPath("closing-refusal")
  const closing = Latch.makeUnsafe()
  const releaseClosing = Latch.makeUnsafe()
  const refused = Latch.makeUnsafe()
  let accepted = 0
  let enrolled = 0
  let finalized = 0
  let refusedSocket: net.Socket | undefined
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let client: net.Socket | undefined
  let shutdown: Promise<void> | undefined
  try {
    server = await startMusicSessionServer(
      { socketPath: path },
      createFakeProvider(),
      {
        onAccepted: () => {
          accepted += 1
        },
        onEnrolled: () => {
          enrolled += 1
        },
        onConnectionFinalized: () => {
          finalized += 1
        },
        onClosing: () => Latch.openUnsafe(closing),
        awaitClosing: Latch.await(releaseClosing),
        onRefused: (socket) => {
          refusedSocket = socket
          Latch.openUnsafe(refused)
        },
      },
    )
    shutdown = server.close()
    await Effect.runPromise(Latch.await(closing))
    const refusalClient = net.createConnection(path)
    client = refusalClient
    const clientClosed = new Promise<void>((resolve, reject) => {
      const remove = () => {
        refusalClient.off("close", onClose)
        refusalClient.off("error", onError)
      }
      const onClose = () => {
        remove()
        resolve()
      }
      const onError = (cause: Error) => {
        remove()
        reject(cause)
      }
      refusalClient.once("close", onClose)
      refusalClient.once("error", onError)
    })
    const outcome = await Promise.race([
      Effect.runPromise(Latch.await(refused)).then(() => "refused"),
      clientClosed.then(() => "closed"),
    ])
    expect(outcome).toBe("refused")
    await clientClosed
    expect(refusedSocket).toBeDefined()
    expect(refusedSocket?.destroyed).toBe(true)
    expect(accepted).toBe(0)
    expect(enrolled).toBe(0)
    expect(finalized).toBe(0)
    Latch.openUnsafe(releaseClosing)
    await shutdown
    expect(existsSync(path)).toBe(false)
  } finally {
    Latch.openUnsafe(refused)
    Latch.openUnsafe(releaseClosing)
    client?.destroy()
    await shutdown?.catch(() => {})
    await server?.close().catch(() => {})
  }
})

test("Node acceptance rejected before enrollment destroys the exact socket", async () => {
  const path = socketPath("acceptance-rejected")
  let nodeAccepted = 0
  let accepted = 0
  let enrolled = 0
  let finalized = 0
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let socket: net.Socket | undefined
  try {
    server = await startMusicSessionServer(
      { socketPath: path },
      createFakeProvider(),
      {
        onNodeConnection: () => {
          nodeAccepted += 1
        },
        canEnroll: () => false,
        onAccepted: () => {
          accepted += 1
        },
        onEnrolled: () => {
          enrolled += 1
        },
        onConnectionFinalized: () => {
          finalized += 1
        },
      },
    )
    socket = net.createConnection(path)
    await new Promise<void>((resolve) => socket?.once("close", resolve))
    expect(nodeAccepted).toBe(1)
    expect(accepted).toBe(0)
    expect(enrolled).toBe(0)
    expect(finalized).toBe(0)
    expect(socket.destroyed).toBe(true)
  } finally {
    socket?.destroy()
    await server?.close().catch(() => {})
  }
})

test("an occupied path reports listen failure without disrupting its owner", async () => {
  const path = socketPath("occupied")
  let owner: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let peer: net.Socket | undefined
  const ownerProvider = createFakeProvider()
  const losingProvider = createFakeProvider()
  try {
    owner = await startMusicSessionServer({ socketPath: path }, ownerProvider)
    await expect(
      startMusicSessionServer({ socketPath: path }, losingProvider),
    ).rejects.toMatchObject({
      _tag: "MusicSession.SocketError",
      operation: "listen",
    })
    expect(existsSync(path)).toBe(true)
    // A bind loser never enters provider/coordinator ownership.
    expect(losingProvider.counts.providerDisposals).toBe(0)
    expect(losingProvider.counts.disposals).toBe(0)
    peer = await connected(path)
    peer.destroy()
    await owner.close()
    expect(existsSync(path)).toBe(false)
  } finally {
    peer?.destroy()
    await owner?.close().catch(() => {})
  }
})

test("a dead exact bind reservation is reclaimed before binding", async () => {
  const path = socketPath("stale-bind-reservation")
  const reservation = `${path}.bind-lock`
  const uid = process.getuid?.()
  if (typeof uid !== "number") throw new Error("expected a POSIX test runtime")
  await writeFile(
    reservation,
    JSON.stringify({ version: 1, uid, pid: 999_999_999 }),
    { mode: 0o600 },
  )
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  try {
    server = await startMusicSessionServer(
      { socketPath: path },
      createFakeProvider(),
    )
    expect(existsSync(path)).toBe(true)
    expect(existsSync(reservation)).toBe(false)
  } finally {
    await server?.close().catch(() => {})
  }
  expect(existsSync(reservation)).toBe(false)
})

test("simultaneous daemon bind contenders retain one provider owner", async () => {
  const path = socketPath("bind-race")
  const firstProvider = createFakeProvider()
  const secondProvider = createFakeProvider()
  let winner: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  try {
    const results = await Promise.allSettled([
      startMusicSessionServer({ socketPath: path }, firstProvider),
      startMusicSessionServer({ socketPath: path }, secondProvider),
    ])
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1)
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1)
    const firstWon = results[0]?.status === "fulfilled"
    const result = results[firstWon ? 0 : 1]
    if (!result || result.status !== "fulfilled")
      throw new Error("expected one bind winner")
    winner = result.value
    const loser = firstWon ? secondProvider : firstProvider
    expect(loser.counts.disposals).toBe(0)
    expect(loser.counts.providerDisposals).toBe(0)
    expect(existsSync(path)).toBe(true)
  } finally {
    await winner?.close().catch(() => {})
  }
})

test("one graph replays hello, status, and state to both clients", async () => {
  const path = socketPath("two-client-replay")
  const provider = createFakeProvider()
  const counts = {
    listener: 0,
    listenerFinalized: 0,
    accepted: 0,
    enrolled: 0,
    input: 0,
    processors: 0,
    connections: 0,
    forwardersStarted: 0,
    forwardersFinalized: 0,
    closes: 0,
    unlinks: 0,
  }
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let one: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  let two: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    const activeServer = await startMusicSessionServer(
      { socketPath: path },
      provider,
      {
        onClose: () => {
          counts.closes += 1
        },
        onUnlink: () => {
          counts.unlinks += 1
        },
        onListener: () => {
          counts.listener += 1
        },
        onListenerFinalized: () => {
          counts.listenerFinalized += 1
        },
        onAccepted: () => {
          counts.accepted += 1
        },
        onEnrolled: () => {
          counts.enrolled += 1
        },
        onInputFinalized: () => {
          counts.input += 1
        },
        onInputProcessorFinalized: () => {
          counts.processors += 1
        },
        onConnectionFinalized: () => {
          counts.connections += 1
        },
        onForwarderStarted: () => {
          counts.forwardersStarted += 1
        },
        onForwarderFinalized: () => {
          counts.forwardersFinalized += 1
        },
      },
    )
    server = activeServer
    const clientOne = await createMusicSessionClient({
      socketPath: path,
      clientId: "replay-one",
      hostKind: "test",
    })
    one = clientOne
    const clientTwo = await createMusicSessionClient({
      socketPath: path,
      clientId: "replay-two",
      hostKind: "test",
    })
    two = clientTwo
    const replay = (client: typeof clientOne) =>
      Promise.all([
        new Promise<void>((resolve) => client.subscribeStatus(() => resolve())),
        new Promise<void>((resolve) => client.subscribeState(() => resolve())),
      ])
    await Promise.all([replay(clientOne), replay(clientTwo)])
    expect(clientOne.daemonInstanceId).toBe(clientTwo.daemonInstanceId)
    expect(clientOne.status?.kind).toBe("ready")
    expect(clientTwo.status?.kind).toBe("ready")
    expect(clientOne.state?.daemonInstanceId).toBe(clientOne.daemonInstanceId)
    expect(clientTwo.state?.daemonInstanceId).toBe(clientTwo.daemonInstanceId)
    expect(counts.listener).toBe(1)
    expect(counts.accepted).toBe(2)
    expect(counts.enrolled).toBe(2)
    expect(provider.counts.subscriptions).toBe(1)
    const broadcast = Promise.all([
      new Promise<void>((resolve) =>
        clientOne.subscribeState((snapshot) => {
          if (snapshot.state.progress_ms === 77) resolve()
        }),
      ),
      new Promise<void>((resolve) =>
        clientTwo.subscribeState((snapshot) => {
          if (snapshot.state.progress_ms === 77) resolve()
        }),
      ),
    ])
    provider.emit({
      type: "snapshot",
      state: { ...provider.state, progress_ms: 77, fetched_at: 77 },
    })
    await broadcast
    expect(clientOne.state?.state.progress_ms).toBe(77)
    expect(clientTwo.state?.state.progress_ms).toBe(77)
    clientOne.dispose()
    clientTwo.dispose()
    await activeServer.close()
    expect(counts).toEqual({
      listener: 1,
      listenerFinalized: 1,
      accepted: 2,
      enrolled: 2,
      input: 2,
      processors: 2,
      connections: 2,
      forwardersStarted: 4,
      forwardersFinalized: 4,
      closes: 1,
      unlinks: 1,
    })
    expect(provider.counts).toMatchObject({
      subscriptions: 1,
      disposals: 1,
      providerDisposals: 1,
    })
    expect(existsSync(path)).toBe(false)
  } finally {
    one?.dispose()
    two?.dispose()
    await server?.close().catch(() => {})
  }
})

test("a disconnected peer does not stop another client's replay", async () => {
  const path = socketPath("peer-isolation")
  const provider = createFakeProvider()
  let finalized = 0
  let forwardersStarted = 0
  let forwardersFinalized = 0
  const sockets: net.Socket[] = []
  const writes = new Map<net.Socket, number>()
  let resolveFinalized: () => void = () => {}
  const connectionFinalized = new Promise<void>((resolve) => {
    resolveFinalized = resolve
  })
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let one: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  let two: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    server = await startMusicSessionServer({ socketPath: path }, provider, {
      onAccepted: (socket) => {
        sockets.push(socket)
      },
      onWriteAttempt: (socket) => {
        writes.set(socket, (writes.get(socket) ?? 0) + 1)
      },
      onForwarderStarted: () => {
        forwardersStarted += 1
      },
      onConnectionFinalized: () => {
        finalized += 1
        if (finalized === 1 && forwardersFinalized === 2) resolveFinalized()
      },
      onForwarderFinalized: () => {
        forwardersFinalized += 1
        if (finalized === 1 && forwardersFinalized === 2) resolveFinalized()
      },
    })
    one = await createMusicSessionClient({
      socketPath: path,
      clientId: "gone",
      hostKind: "test",
    })
    two = await createMusicSessionClient({
      socketPath: path,
      clientId: "live",
      hostKind: "test",
    })
    expect(forwardersStarted).toBe(4)
    const update = new Promise<void>((resolve) =>
      two?.subscribeState((snapshot) => {
        if (snapshot.state.progress_ms === 42) resolve()
      }),
    )
    one.dispose()
    await connectionFinalized
    expect(finalized).toBe(1)
    expect(forwardersFinalized).toBe(2)
    const departed = sockets[0]
    const live = sockets[1]
    if (!departed || !live) throw new Error("server sockets were not accepted")
    const departedWrites = writes.get(departed) ?? 0
    const liveWrites = writes.get(live) ?? 0
    provider.emit({
      type: "snapshot",
      state: { ...provider.state, progress_ms: 42, fetched_at: 2 },
    })
    await update
    expect(writes.get(departed) ?? 0).toBe(departedWrites)
    expect(writes.get(live) ?? 0).toBeGreaterThan(liveWrites)
    expect(two.state?.state.progress_ms).toBe(42)
  } finally {
    one?.dispose()
    two?.dispose()
    await server?.close().catch(() => {})
  }
})

test("post-bind listener faults reach the Promise facade", async () => {
  const path = socketPath("post-bind-fault")
  let listener: net.Server | undefined
  const provider = createFakeProvider()
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  try {
    server = await startMusicSessionServer({ socketPath: path }, provider, {
      onListener: (next) => (listener = next),
    })
    if (!listener) throw new Error("listener was not acquired")
    listener.emit("error", new Error("post-bind failure"))
    await expect(server.close()).rejects.toMatchObject({
      _tag: "MusicSession.SocketError",
      operation: "server",
    })
    expect(existsSync(path)).toBe(false)
    expect(provider.counts.disposals).toBe(1)
    expect(provider.counts.providerDisposals).toBe(1)
  } finally {
    await server?.close().catch(() => {})
  }
})

test("close failure remains typed after real cleanup and is memoized", async () => {
  const path = socketPath("close-failure")
  const provider = createFakeProvider()
  let closes = 0
  let unlinks = 0
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  try {
    server = await startMusicSessionServer({ socketPath: path }, provider, {
      closeFailure: () => new Error("injected close failure"),
      onClose: () => {
        closes += 1
      },
      onUnlink: () => {
        unlinks += 1
      },
    })
    const first = server.close()
    expect(server.close()).toBe(first)
    await expect(first).rejects.toMatchObject({
      _tag: "MusicSession.SocketError",
      operation: "close",
    })
    expect(existsSync(path)).toBe(false)
    expect(closes).toBe(1)
    expect(unlinks).toBe(1)
    expect(provider.counts.disposals).toBe(1)
    expect(provider.counts.providerDisposals).toBe(1)
  } finally {
    await server?.close().catch(() => {})
  }
})

test("multiple cleanup failures retain both tagged operations", async () => {
  const path = socketPath("multiple-cleanup-failures")
  const observed: string[] = []
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  try {
    server = await startMusicSessionServer(
      { socketPath: path },
      createFakeProvider(),
      {
        closeFailure: () => new Error("close failure"),
        unlinkFailure: () =>
          Object.assign(new Error("unlink failure"), { code: "EACCES" }),
        onCleanupFailure: (error) => observed.push(error.operation),
      },
    )
    await expect(server.close()).rejects.toMatchObject({ operation: "close" })
    expect(observed).toEqual(["close", "unlink"])
    expect(existsSync(path)).toBe(false)
  } finally {
    await server?.close().catch(() => {})
  }
})

test("unlink failures are typed after listener cleanup and ENOENT is tolerated", async () => {
  const failedPath = socketPath("unlink-failure")
  let unlinks = 0
  const error = Object.assign(new Error("injected unlink failure"), {
    code: "EACCES",
  })
  let failed: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let tolerated: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  try {
    failed = await startMusicSessionServer(
      { socketPath: failedPath },
      createFakeProvider(),
      {
        unlinkFailure: () => error,
        onUnlink: () => {
          unlinks += 1
        },
      },
    )
    await expect(failed.close()).rejects.toMatchObject({
      _tag: "MusicSession.SocketError",
      operation: "unlink",
    })
    expect(existsSync(failedPath)).toBe(false)
    expect(unlinks).toBe(1)

    const enoentPath = socketPath("unlink-enoent")
    tolerated = await startMusicSessionServer(
      { socketPath: enoentPath },
      createFakeProvider(),
      {
        unlinkFailure: () =>
          Object.assign(new Error("gone"), { code: "ENOENT" }),
      },
    )
    await tolerated.close()
    expect(existsSync(enoentPath)).toBe(false)
  } finally {
    await failed?.close().catch(() => {})
    await tolerated?.close().catch(() => {})
  }
})

test("executable composes one real graph for managed default and explicit sockets", async () => {
  for (const mode of ["managed", "explicit"] as const) {
    const root = await mkdtemp(`/tmp/music-sessiond-${mode}-`)
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid: process.getuid?.() ?? -1,
    })
    const explicitPath = `${root}/explicit.sock`
    const signals = new EventEmitter()
    const provider = createFakeProvider()
    let graphs = 0
    let observed: Awaited<ReturnType<typeof lstat>> | undefined
    let observation: Promise<void> | undefined
    let observationError: unknown
    try {
      await runMusicSessionDaemon({
        argv: mode === "managed" ? [] : ["--socket", explicitPath],
        runtime,
        signals,
        diagnostic: (message) => {
          if (
            message.startsWith("music-sessiond listening") &&
            observation === undefined
          )
            observation = (async () => {
              try {
                observed = await lstat(
                  mode === "managed" ? runtime.socketPath : explicitPath,
                )
              } catch (cause) {
                observationError = cause
              } finally {
                signals.emit("SIGTERM")
              }
            })()
        },
        graph: (options) => {
          graphs++
          return Layer.provide(
            layerWithHooks({}, layerFromLegacy(provider)),

            configLayer(options),
          )
        },
      })
      await observation
      if (observationError) throw observationError
      expect(graphs).toBe(1)
      expect(observed?.isSocket()).toBe(true)
      expect(Number(observed?.mode) & 0o777).toBe(0o600)
      expect(provider.counts.providerDisposals).toBe(1)
      if (mode === "managed") {
        expect((await lstat(runtime.directory)).mode & 0o777).toBe(0o700)
        expect(existsSync(runtime.socketPath)).toBe(false)
      } else {
        expect(existsSync(runtime.directory)).toBe(false)
        expect(existsSync(explicitPath)).toBe(false)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("executable reports actual unsafe managed-runtime preparation with nonzero status", async () => {
  const root = await mkdtemp("/tmp/music-sessiond-unsafe-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  const diagnostics: string[] = []
  const statuses: number[] = []
  try {
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    await chmod(runtime.directory, 0o755)
    await runMusicSessionDaemon({
      argv: [],
      runtime,
      diagnostic: (message) => diagnostics.push(message),
      setStatus: (status) => statuses.push(status),
      graph: (options) =>
        Layer.provide(
          layerWithHooks({}, layerFromLegacy(createFakeProvider())),

          configLayer(options),
        ),
    })
    expect(statuses).toEqual([1])
    expect(diagnostics.join("\n")).toContain("MusicSession.SocketError")
    expect(diagnostics.join("\n")).toContain("[prepare]")
    expect(diagnostics.join("\n")).toContain(runtime.directory)
    expect(diagnostics.join("\n")).toContain("owner-only directory")
    expect((await lstat(runtime.directory)).mode & 0o777).toBe(0o755)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("executable reports cleanup failure with nonzero status after SIGTERM", async () => {
  let directory: string | undefined
  let daemon: ReturnType<typeof Bun.spawn> | undefined
  let diagnostics: ReadableStream<Uint8Array> | undefined
  try {
    directory = await mkdtemp("/tmp/music-sessiond-executable-")
    const runner = new URL("../session/music-sessiond.ts", import.meta.url).href
    const config = new URL("../session/config.ts", import.meta.url).href
    const provider = new URL("../session/provider.ts", import.meta.url).href
    const server = new URL("../session/server.ts", import.meta.url).href
    const path = `${directory}/daemon.sock`
    daemon = Bun.spawn(
      [
        process.execPath,
        "--cwd",
        new URL("..", import.meta.url).pathname,
        "--eval",
        `import { Layer } from "effect";
         import { runMusicSessionDaemon } from ${JSON.stringify(runner)};
         import { layer as configLayer } from ${JSON.stringify(config)};
         import { createFakeProvider, layerFromLegacy } from ${JSON.stringify(provider)};
         import { layerWithHooks } from ${JSON.stringify(server)};
         await runMusicSessionDaemon({
           argv: process.argv.slice(1),
           graph: (options) => Layer.provide(
             layerWithHooks({
               closeFailure: () => new Error("injected executable close failure"),
               onUnlink: () => console.error("test unlink completed"),
             }, layerFromLegacy(createFakeProvider())),

             configLayer(options),
           ),
         });`,
        "--",
        "--socket",
        path,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    const stderr = daemon.stderr
    if (!stderr || typeof stderr === "number")
      throw new Error("daemon stderr was not piped")
    const [ready, output] = stderr.tee()
    diagnostics = output
    await readUntil(ready, "music-sessiond listening")
    daemon.kill("SIGTERM")
    const text = await new Response(diagnostics).text()
    expect(await daemon.exited).toBe(1)
    expect(text).toContain("MusicSession.SocketError")
    expect(text).toContain("[close]")
    expect(text).toContain("injected executable close failure")
    expect(text).toContain("test unlink completed")
    expect(existsSync(path)).toBe(false)
  } finally {
    if (daemon) {
      daemon.kill("SIGKILL")
      await daemon.exited
    }
    if (directory) await rm(directory, { recursive: true, force: true })
  }
})

test("direct Layer owners join tagged cleanup in one outer program", async () => {
  const path = socketPath("direct-layer-cleanup")
  const provider = createFakeProvider()
  const serverWithCoordinator = layerWithHooks(
    { closeFailure: () => new Error("direct close failure") },
    layerFromLegacy(provider),
  )
  const graph = Layer.provide(
    serverWithCoordinator,
    configLayer({ socketPath: path }),
  )
  let closeScope: (() => Promise<void>) | undefined
  try {
    const scope = await Effect.runPromise(Scope.make())
    closeScope = () => Effect.runPromise(Scope.close(scope, Exit.void))
    const cleanup = await Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* Scope.provide(scope)(Layer.build(graph))
        const service = Context.get(context, MusicSessionServerService)
        yield* Scope.close(scope, Exit.void)
        return yield* service.awaitCleanup
      }),
    )
    expect(cleanup).toMatchObject([{ operation: "close" }])
    expect(existsSync(path)).toBe(false)
    expect(provider.counts.providerDisposals).toBe(1)
  } finally {
    await closeScope?.()
  }
})

test("server close interrupts blocked coordinator sampling and finalizes ownership", async () => {
  const path = socketPath("blocked-sample")
  let closeScope: (() => Promise<void>) | undefined
  let socket: net.Socket | undefined
  const counts = {
    listener: 0,
    listenerFinalized: 0,
    input: 0,
    processor: 0,
    connection: 0,
    closes: 0,
    unlinks: 0,
  }
  try {
    const fixture = await Effect.runPromise(makeCoordinatorProviderFixture())
    const scope = await Effect.runPromise(Scope.make())
    closeScope = () => Effect.runPromise(Scope.close(scope, Exit.void))
    const graph = Layer.provide(
      layerWithHooks(
        {
          onClose: () => {
            counts.closes += 1
          },
          onUnlink: () => {
            counts.unlinks += 1
          },
          onListener: () => {
            counts.listener += 1
          },
          onListenerFinalized: () => {
            counts.listenerFinalized += 1
          },
          onInputFinalized: () => {
            counts.input += 1
          },
          onInputProcessorFinalized: () => {
            counts.processor += 1
          },
          onConnectionFinalized: () => {
            counts.connection += 1
          },
        },
        fixture.layer,
      ),
      configLayer({ socketPath: path }),
    )
    await Effect.runPromise(Scope.provide(scope)(Layer.build(graph)))
    await Effect.runPromise(Latch.await(fixture.eventSubscribed))
    socket = await connected(path)
    // Consume the completed initial sample, then block the invalidation sample.
    await Effect.runPromise(Queue.take(fixture.sampleStarts))
    await Effect.runPromise(fixture.blockSample)
    await Effect.runPromise(
      fixture.emit({ type: "invalidation", reason: "stream-terminated" }),
    )
    await Effect.runPromise(Queue.take(fixture.sampleStarts))
    await Effect.runPromise(Scope.close(scope, Exit.void))
    expect(await Effect.runPromise(Ref.get(fixture.activeSamples))).toBe(0)
    expect(await Effect.runPromise(Ref.get(fixture.interruptedSamples))).toBe(1)
    expect(await Effect.runPromise(Ref.get(fixture.subscriptions))).toBe(1)
    expect(await Effect.runPromise(Ref.get(fixture.eventFinalizations))).toBe(1)
    expect(await Effect.runPromise(Ref.get(fixture.finalizations))).toBe(1)
    expect(counts).toEqual({
      listener: 1,
      listenerFinalized: 1,
      input: 1,
      processor: 1,
      connection: 1,
      closes: 1,
      unlinks: 1,
    })
    expect(socket.destroyed).toBe(true)
    expect(existsSync(path)).toBe(false)
  } finally {
    socket?.destroy()
    await closeScope?.()
  }
})

test("selected graph shutdown interrupts blocked coordinator work before draining connections", async () => {
  const path = socketPath("blocked-command")
  let closeScope: (() => Promise<void>) | undefined
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  let accepted: net.Socket | undefined
  let writes = 0
  let settled = 0
  let inputFinalized = 0
  let connectionFinalized = 0
  const order: string[] = []
  let fixture!: CoordinatorProviderFixture
  try {
    fixture = await Effect.runPromise(makeCoordinatorProviderFixture())
    await Effect.runPromise(fixture.blockTransport)
    const scope = await Effect.runPromise(Scope.make())
    closeScope = () => Effect.runPromise(Scope.close(scope, Exit.void))
    const graph = Layer.provide(
      layerWithHooks(
        {
          onClosing: () => order.push("closing"),
          onCoordinatorScopeFinalized: () => order.push("coordinator"),
          onAccepted: (socket) => {
            accepted = socket
          },
          onInputProcessorFinalized: () => {
            inputFinalized += 1
          },
          onConnectionFinalized: () => {
            connectionFinalized += 1
            order.push("connection")
          },
          onProviderScopeFinalized: () => order.push("provider"),
          onListenerFinalized: () => order.push("listener"),
          onUnlink: () => order.push("unlink"),
          onWriteAttempt: () => {
            writes += 1
          },
        },
        fixture.layer,
      ),
      configLayer({ socketPath: path }),
    )
    await Effect.runPromise(Scope.provide(scope)(Layer.build(graph)))
    client = await createMusicSessionClient({
      socketPath: path,
      clientId: "blocked-command",
      hostKind: "test",
    })
    const pending = client.play()
    void pending.then(
      () => settled++,
      () => settled++,
    )
    await Effect.runPromise(Latch.await(fixture.transportStarted))
    await Effect.runPromise(
      Scope.close(scope, Exit.void).pipe(Effect.timeout("5 seconds")),
    )
    await expect(pending).rejects.toMatchObject({
      name: "MusicSessionClientError",
      code: "INDETERMINATE_COMMAND",
    })
    expect(settled).toBe(1)
    expect(await Effect.runPromise(Ref.get(fixture.activeTransports))).toBe(0)
    expect(inputFinalized).toBe(1)
    expect(connectionFinalized).toBe(1)
    expect(await Effect.runPromise(Ref.get(fixture.subscriptions))).toBe(1)
    expect(await Effect.runPromise(Ref.get(fixture.eventFinalizations))).toBe(1)
    expect(await Effect.runPromise(Ref.get(fixture.finalizations))).toBe(1)
    expect(order).toEqual([
      "closing",
      "coordinator",
      "connection",
      "provider",
      "listener",
      "unlink",
    ])
    expect(accepted?.destroyed).toBe(true)
    expect(existsSync(path)).toBe(false)
    const writesAfterFinalization = writes
    await Effect.runPromise(fixture.releaseTransport)
    await Promise.resolve()
    expect(writes).toBe(writesAfterFinalization)
  } finally {
    client?.dispose()
    await Effect.runPromise(fixture?.releaseTransport ?? Effect.void).catch(
      () => {},
    )
    await closeScope?.()
  }
})

test("two socket admissions retain FIFO order while the first transport blocks", async () => {
  const path = socketPath("command-admission")
  let closeScope: (() => Promise<void>) | undefined
  const admissions: string[] = []
  let resolveSecondAdmission: () => void = () => {}
  const secondAdmission = new Promise<void>((resolve) => {
    resolveSecondAdmission = resolve
  })
  let one: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  let two: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    const fixture = await Effect.runPromise(makeCoordinatorProviderFixture())
    const scope = await Effect.runPromise(Scope.make())
    closeScope = () => Effect.runPromise(Scope.close(scope, Exit.void))
    await Effect.runPromise(fixture.blockTransport)
    const graph = Layer.provide(
      layerWithHooks(
        {
          onCommandAdmission: (action) => {
            admissions.push(action)
            if (admissions.length === 2) resolveSecondAdmission()
          },
        },
        fixture.layer,
      ),
      configLayer({ socketPath: path }),
    )
    await Effect.runPromise(Scope.provide(scope)(Layer.build(graph)))
    one = await createMusicSessionClient({
      socketPath: path,
      clientId: "admission-one",
      hostKind: "test",
    })
    two = await createMusicSessionClient({
      socketPath: path,
      clientId: "admission-two",
      hostKind: "test",
    })
    const first = one.play()
    await Effect.runPromise(Latch.await(fixture.transportStarted))
    const second = two.pause()
    await secondAdmission
    expect(admissions).toEqual(["play", "pause"])
    expect(await Effect.runPromise(Ref.get(fixture.calls))).toEqual([
      { action: "play" },
    ])
    await Effect.runPromise(fixture.releaseTransport)
    await Promise.all([first, second])
    expect(await Effect.runPromise(Ref.get(fixture.calls))).toEqual([
      { action: "play" },
      { action: "pause" },
    ])
  } finally {
    one?.dispose()
    two?.dispose()
    await closeScope?.()
  }
})

test("two clients share the daemon command lane", async () => {
  const path = socketPath("commands")
  const provider = createFakeProvider()
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let one: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  let two: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    const activeServer = await startMusicSessionServer(
      {
        socketPath: path,
        pollMs: { playing: 100000, paused: 100000, idle: 100000 },
      },
      provider,
    )
    server = activeServer
    const first = await createMusicSessionClient({
      socketPath: path,
      clientId: "one",
      hostKind: "test",
    })
    one = first
    const second = await createMusicSessionClient({
      socketPath: path,
      clientId: "two",
      hostKind: "test",
    })
    two = second
    await Promise.all([first.play(), second.pause()])
    expect(provider.calls).toEqual(["play", "pause"])
    first.dispose()
    second.dispose()
    await activeServer.close()
    expect(existsSync(path)).toBe(false)
  } finally {
    one?.dispose()
    two?.dispose()
    await server?.close().catch(() => {})
  }
})
