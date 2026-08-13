import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import net from "node:net"
import { Context, Effect, Exit, Latch, Layer, Queue, Ref, Scope } from "effect"
import { layer as configLayer } from "../session/config.ts"
import { layer as coordinatorLayer } from "../session/coordinator.ts"
import {
  createFakeProvider,
  layerFromLegacy,
  makeCoordinatorProviderFixture,
} from "../session/provider.ts"
import {
  layerWithHooks,
  MusicSessionServerService,
  startMusicSessionServer,
} from "../session/server.ts"
import { createMusicSessionClient } from "../session/client.ts"
import { waitForSignal } from "../session/music-sessiond.ts"

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
    socket.once("connect", () => resolve(socket))
    socket.once("error", reject)
  })
}

test("scoped signal wait removes both handlers after a signal", async () => {
  const signals = new EventEmitter()
  const waiting = Effect.runPromise(waitForSignal(signals))
  expect(signals.listenerCount("SIGINT")).toBe(1)
  expect(signals.listenerCount("SIGTERM")).toBe(1)
  signals.emit("SIGINT")
  await waiting
  expect(signals.listenerCount("SIGINT")).toBe(0)
  expect(signals.listenerCount("SIGTERM")).toBe(0)
})

test("scoped signal wait removes both handlers on interruption", async () => {
  const signals = new EventEmitter()
  await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      yield* Effect.forkIn(scope, { startImmediately: true })(
        waitForSignal(signals),
      )
      expect(signals.listenerCount("SIGINT")).toBe(1)
      expect(signals.listenerCount("SIGTERM")).toBe(1)
      yield* Scope.close(scope, Exit.void)
    }),
  )
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
  const server = await startMusicSessionServer({ socketPath: path }, provider, {
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
  const socket = await connected(path)
  try {
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
    socket.destroy()
    await server.close().catch(() => {})
  }
})

test("server close interrupts post-hello forwarding before late provider events", async () => {
  const path = socketPath("active")
  const provider = createFakeProvider()
  let writes = 0
  const server = await startMusicSessionServer({ socketPath: path }, provider, {
    onWriteAttempt: () => {
      writes += 1
    },
  })
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
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
    await server.close().catch(() => {})
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
  const server = await startMusicSessionServer(
    { socketPath: path },
    undefined,
    {
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
    },
  )
  const partial = await connected(path)
  try {
    const closed = new Promise<void>((resolve) =>
      partial.once("close", resolve),
    )
    partial.write('{"type":"hello"')
    partial.end()
    await closed
    await finalized
    // EOF is processed by the serial input fiber before its finalization.
    expect(eofProcessed).toBe(1)
    expect(inputs).toBe(1)
    expect(processors).toBe(1)
    expect(connections).toBe(1)
    const healthy = await connected(path)
    healthy.destroy()
  } finally {
    partial.destroy()
    await server.close()
  }
})

test("natural malformed-client disconnect leaves the listener healthy", async () => {
  const path = socketPath("mid-frame")
  const server = await startMusicSessionServer({ socketPath: path })
  let partial: net.Socket | undefined
  let healthy: net.Socket | undefined
  try {
    partial = await connected(path)
    const closed = new Promise<void>((resolve) =>
      partial?.once("close", resolve),
    )
    partial.write('{"type":"hello"')
    partial.end()
    await closed
    healthy = await connected(path)
    healthy.destroy()
    await server.close()
    expect(existsSync(path)).toBe(false)
  } finally {
    partial?.destroy()
    healthy?.destroy()
    await server.close().catch(() => {})
  }
})

test("correlates an invalid request without closing the listener", async () => {
  const path = socketPath("invalid")
  const server = await startMusicSessionServer(
    { socketPath: path },
    createFakeProvider(),
  )
  let socket: net.Socket | undefined
  try {
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
    await server.close().catch(() => {})
  }
})

test("socket defects are observed while a healthy peer remains live", async () => {
  const path = socketPath("socket-defect")
  const failures: unknown[] = []
  const accepted: net.Socket[] = []
  const provider = createFakeProvider()
  const server = await startMusicSessionServer({ socketPath: path }, provider, {
    onAccepted: (socket) => accepted.push(socket),
    onConnectionFailure: (cause) => failures.push(cause),
  })
  let broken: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  let healthy: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
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
    await server.close().catch(() => {})
  }
})

test("throwing enrollment seam still destroys the accepted socket", async () => {
  const path = socketPath("acceptance-hook-throw")
  const server = await startMusicSessionServer(
    { socketPath: path },
    createFakeProvider(),
    {
      canEnroll: () => {
        throw new Error("injected enrollment hook fault")
      },
    },
  )
  let socket: net.Socket | undefined
  try {
    socket = net.createConnection(path)
    await new Promise<void>((resolve) => socket?.once("close", resolve))
    expect(socket.destroyed).toBe(true)
  } finally {
    socket?.destroy()
    await server.close().catch(() => {})
  }
})

test("acceptance during actual server shutdown is enrolled then finalized", async () => {
  const path = socketPath("acceptance-shutdown")
  let accepted = 0
  let enrolled = 0
  let finalized = 0
  let closing: Promise<void> | undefined
  let server: Awaited<ReturnType<typeof startMusicSessionServer>>
  server = await startMusicSessionServer(
    { socketPath: path },
    createFakeProvider(),
    {
      onNodeConnection: () => {
        closing ??= server.close()
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
  let socket: net.Socket | undefined
  try {
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
    await server.close().catch(() => {})
  }
})

test("production acceptance callback refuses sockets after shutdown begins", async () => {
  const path = socketPath("closing-refusal")
  let accepted = 0
  let enrolled = 0
  let finalized = 0
  let refused: net.Socket | undefined
  const server = await startMusicSessionServer(
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
      onClosing: (accept) => {
        refused = new net.Socket()
        accept(refused)
      },
    },
  )
  try {
    await server.close()
    expect(refused?.destroyed).toBe(true)
    expect(accepted).toBe(0)
    expect(enrolled).toBe(0)
    expect(finalized).toBe(0)
    expect(existsSync(path)).toBe(false)
  } finally {
    refused?.destroy()
    await server.close().catch(() => {})
  }
})

test("Node acceptance rejected before enrollment destroys the exact socket", async () => {
  const path = socketPath("acceptance-rejected")
  let nodeAccepted = 0
  let accepted = 0
  let enrolled = 0
  let finalized = 0
  const server = await startMusicSessionServer(
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
  let socket: net.Socket | undefined
  try {
    socket = net.createConnection(path)
    await new Promise<void>((resolve) => socket?.once("close", resolve))
    expect(nodeAccepted).toBe(1)
    expect(accepted).toBe(0)
    expect(enrolled).toBe(0)
    expect(finalized).toBe(0)
    expect(socket.destroyed).toBe(true)
  } finally {
    socket?.destroy()
    await server.close().catch(() => {})
  }
})

test("an occupied path reports listen failure without disrupting its owner", async () => {
  const path = socketPath("occupied")
  const owner = await startMusicSessionServer(
    { socketPath: path },
    createFakeProvider(),
  )
  let peer: net.Socket | undefined
  try {
    await expect(
      startMusicSessionServer({ socketPath: path }, createFakeProvider()),
    ).rejects.toMatchObject({
      _tag: "MusicSession.SocketError",
      operation: "listen",
    })
    expect(existsSync(path)).toBe(true)
    peer = await connected(path)
    peer.destroy()
    await owner.close()
    expect(existsSync(path)).toBe(false)
  } finally {
    peer?.destroy()
    await owner.close().catch(() => {})
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
  const server = await startMusicSessionServer({ socketPath: path }, provider, {
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
  })
  let one: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  let two: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    const [clientOne, clientTwo] = await Promise.all([
      createMusicSessionClient({
        socketPath: path,
        clientId: "replay-one",
        hostKind: "test",
      }),
      createMusicSessionClient({
        socketPath: path,
        clientId: "replay-two",
        hostKind: "test",
      }),
    ])
    one = clientOne
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
    await server.close()
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
    await server.close().catch(() => {})
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
  const server = await startMusicSessionServer({ socketPath: path }, provider, {
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
  let one: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  let two: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
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
    await server.close().catch(() => {})
  }
})

test("post-bind listener faults reach the Promise facade", async () => {
  const path = socketPath("post-bind-fault")
  let listener: net.Server | undefined
  const provider = createFakeProvider()
  const server = await startMusicSessionServer({ socketPath: path }, provider, {
    onListener: (next) => (listener = next),
  })
  try {
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
    await server.close().catch(() => {})
  }
})

test("close failure remains typed after real cleanup and is memoized", async () => {
  const path = socketPath("close-failure")
  const provider = createFakeProvider()
  let closes = 0
  let unlinks = 0
  const server = await startMusicSessionServer({ socketPath: path }, provider, {
    closeFailure: () => new Error("injected close failure"),
    onClose: () => {
      closes += 1
    },
    onUnlink: () => {
      unlinks += 1
    },
  })
  try {
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
    await server.close().catch(() => {})
  }
})

test("multiple cleanup failures retain both tagged operations", async () => {
  const path = socketPath("multiple-cleanup-failures")
  const observed: string[] = []
  const server = await startMusicSessionServer(
    { socketPath: path },
    createFakeProvider(),
    {
      closeFailure: () => new Error("close failure"),
      unlinkFailure: () =>
        Object.assign(new Error("unlink failure"), { code: "EACCES" }),
      onCleanupFailure: (error) => observed.push(error.operation),
    },
  )
  try {
    await expect(server.close()).rejects.toMatchObject({ operation: "close" })
    expect(observed).toEqual(["close", "unlink"])
    expect(existsSync(path)).toBe(false)
  } finally {
    await server.close().catch(() => {})
  }
})

test("unlink failures are typed after listener cleanup and ENOENT is tolerated", async () => {
  const failedPath = socketPath("unlink-failure")
  let unlinks = 0
  const error = Object.assign(new Error("injected unlink failure"), {
    code: "EACCES",
  })
  const failed = await startMusicSessionServer(
    { socketPath: failedPath },
    createFakeProvider(),
    {
      unlinkFailure: () => error,
      onUnlink: () => {
        unlinks += 1
      },
    },
  )
  let tolerated: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  try {
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
    await failed.close().catch(() => {})
    await tolerated?.close().catch(() => {})
  }
})

test("the executable reports tagged cleanup failure after SIGTERM", async () => {
  const directory = await mkdtemp("/tmp/music-sessiond-executable-")
  const path = `${directory}/daemon.sock`
  let daemon: ReturnType<typeof Bun.spawn> | undefined
  try {
    daemon = Bun.spawn(
      [
        process.execPath,
        "run",
        new URL("../session/music-sessiond.ts", import.meta.url).pathname,
        "--socket",
        path,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    const stderr = daemon.stderr
    if (!stderr || typeof stderr === "number")
      throw new Error("daemon stderr was not piped")
    const [ready, diagnostics] = stderr.tee()
    await readUntil(ready, "music-sessiond listening")
    // This is a real unlink failure at the executable process boundary; the
    // parent restores the directory only after the daemon has finalized.
    await chmod(directory, 0o500)
    daemon.kill("SIGTERM")
    const output = await new Response(diagnostics).text()
    expect(await daemon.exited).toBe(1)
    expect(output).toContain("MusicSession.SocketError")
    expect(output).toContain("[unlink]")
    // The artifact remains because unlink failed, but signal-driven scope
    // closure has already closed the listener that owned it.
    expect(existsSync(path)).toBe(true)
    await expect(connected(path)).rejects.toBeInstanceOf(Error)
  } finally {
    if (daemon) {
      daemon.kill("SIGKILL")
      await daemon.exited
    }
    await chmod(directory, 0o700).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

test("direct Layer owners join tagged cleanup in one outer program", async () => {
  const path = socketPath("direct-layer-cleanup")
  const provider = createFakeProvider()
  const coordinatorWithProvider = Layer.provide(
    coordinatorLayer,
    layerFromLegacy(provider),
  )
  const serverWithCoordinator = Layer.provide(
    layerWithHooks({ closeFailure: () => new Error("direct close failure") }),
    coordinatorWithProvider,
  )
  const graph = Layer.provide(
    serverWithCoordinator,
    configLayer({ socketPath: path }),
  )
  const scope = await Effect.runPromise(Scope.make())
  try {
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
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

test("server close interrupts blocked coordinator sampling and finalizes ownership", async () => {
  const path = socketPath("blocked-sample")
  const fixture = await Effect.runPromise(makeCoordinatorProviderFixture())
  const scope = await Effect.runPromise(Scope.make())
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
    const coordinatorWithProvider = Layer.provide(
      coordinatorLayer,
      fixture.layer,
    )
    const graph = Layer.provide(
      Layer.provide(
        layerWithHooks({
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
        }),
        coordinatorWithProvider,
      ),
      configLayer({ socketPath: path }),
    )
    await Effect.runPromise(Scope.provide(scope)(Layer.build(graph)))
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
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

test("server scope interrupts a blocked socket command without a late response", async () => {
  const path = socketPath("blocked-command")
  const fixture = await Effect.runPromise(makeCoordinatorProviderFixture())
  await Effect.runPromise(fixture.blockTransport)
  const scope = await Effect.runPromise(Scope.make())
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  let writes = 0
  let finalized = 0
  try {
    const coordinatorWithProvider = Layer.provide(
      coordinatorLayer,
      fixture.layer,
    )
    const graph = Layer.provide(
      Layer.provide(
        layerWithHooks({
          onWriteAttempt: () => {
            writes += 1
          },
          onConnectionFinalized: () => {
            finalized += 1
          },
        }),
        coordinatorWithProvider,
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
    void pending.catch(() => {})
    await Effect.runPromise(Latch.await(fixture.transportStarted))
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await expect(pending).rejects.toMatchObject({
      name: "MusicSessionClientError",
      message: "connection closed before command result",
    })
    expect(finalized).toBe(1)
    expect(await Effect.runPromise(Ref.get(fixture.activeTransports))).toBe(0)
    const writesAfterFinalization = writes
    await Effect.runPromise(fixture.releaseTransport)
    await Promise.resolve()
    expect(writes).toBe(writesAfterFinalization)
    expect(existsSync(path)).toBe(false)
  } finally {
    client?.dispose()
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

test("two socket admissions retain FIFO order while the first transport blocks", async () => {
  const path = socketPath("command-admission")
  const fixture = await Effect.runPromise(makeCoordinatorProviderFixture())
  const scope = await Effect.runPromise(Scope.make())
  const admissions: string[] = []
  let resolveSecondAdmission: () => void = () => {}
  const secondAdmission = new Promise<void>((resolve) => {
    resolveSecondAdmission = resolve
  })
  let one: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  let two: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    await Effect.runPromise(fixture.blockTransport)
    const graph = Layer.provide(
      Layer.provide(
        layerWithHooks({
          onCommandAdmission: (action) => {
            admissions.push(action)
            if (admissions.length === 2) resolveSecondAdmission()
          },
        }),
        Layer.provide(coordinatorLayer, fixture.layer),
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
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

test("two clients share the daemon command lane", async () => {
  const path = socketPath("commands")
  const provider = createFakeProvider()
  const server = await startMusicSessionServer(
    {
      socketPath: path,
      pollMs: { playing: 100000, paused: 100000, idle: 100000 },
    },
    provider,
  )
  const [one, two] = await Promise.all([
    createMusicSessionClient({
      socketPath: path,
      clientId: "one",
      hostKind: "test",
    }),
    createMusicSessionClient({
      socketPath: path,
      clientId: "two",
      hostKind: "test",
    }),
  ])
  try {
    await Promise.all([one.play(), two.pause()])
    expect(provider.calls).toEqual(["play", "pause"])
    one.dispose()
    two.dispose()
    await server.close()
    expect(existsSync(path)).toBe(false)
  } finally {
    one.dispose()
    two.dispose()
    await server.close().catch(() => {})
  }
})
