import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import net from "node:net"
import { NdjsonFramer } from "../session/framing.ts"
import {
  MusicSessionClientError,
  createMusicSessionClient,
} from "../session/client.ts"
import {
  createFakeProvider,
  startMusicSessionServer,
} from "../session/server.ts"

type ScriptedFrame = { type: string; requestId: number; action?: string }
type ScriptedDaemon = {
  readonly path: string
  connections(): number
  accepted(): Promise<void>
  received(count: number): Promise<ScriptedFrame[]>
  frames(): ScriptedFrame[]
  closed(): Promise<void>
  send(frame: unknown): void
  write(...chunks: string[]): Promise<void>
  end(): void
  destroy(): void
  error(): void
  close(): Promise<void>
}

async function startScriptedDaemon(helloTail = ""): Promise<ScriptedDaemon> {
  const path = `/tmp/music-session-scripted-${process.pid}-${randomUUID()}.sock`
  const received: ScriptedFrame[] = []
  const receivedWaiters = new Set<{
    readonly count: number
    readonly resolve: () => void
    readonly reject: (cause: Error) => void
  }>()
  let socket: net.Socket | undefined
  let connectionCount = 0
  let terminal: Error | undefined
  let resolveAccepted: () => void = () => {}
  const accepted = new Promise<void>((resolve) => (resolveAccepted = resolve))
  let resolveClosed: () => void = () => {}
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve))
  const rejectWaiters = (cause: Error) => {
    terminal ??= cause
    for (const waiter of receivedWaiters) waiter.reject(terminal)
    receivedWaiters.clear()
  }
  const server = net.createServer((connection) => {
    connectionCount++
    socket = connection
    connection.on("error", rejectWaiters)
    connection.once("close", () => {
      rejectWaiters(new Error("scripted daemon socket closed"))
      resolveClosed()
    })
    resolveAccepted()
    const framer = new NdjsonFramer()
    connection.on("data", (chunk) => {
      for (const frame of framer.push(chunk) as ScriptedFrame[]) {
        received.push(frame)
        for (const waiter of [...receivedWaiters])
          if (received.length >= waiter.count) {
            receivedWaiters.delete(waiter)
            waiter.resolve()
          }
        if (frame.type === "hello")
          connection.write(
            `${JSON.stringify({ type: "response", requestId: 0, ok: true, data: { daemonInstanceId: "daemon", packageVersion: "test", protocol: { major: 1, minRevision: 0, maxRevision: 1, selectedRevision: 1 }, capabilities: ["state-replay", "transport"] } })}\n${helloTail}`,
          )
      }
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(path, resolve)
    })
  } catch (cause) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(path, { force: true })
    throw cause
  }
  return {
    path,
    connections: () => connectionCount,
    accepted: () => accepted,
    received: async (count) => {
      if (received.length < count) {
        if (terminal) throw terminal
        await new Promise<void>((resolve, reject) =>
          receivedWaiters.add({ count, resolve, reject }),
        )
      }
      return received.slice(0, count)
    },
    frames: () => [...received],
    closed: () => closed,
    send: (frame) => socket!.write(`${JSON.stringify(frame)}\n`),
    write: async (...chunks) => {
      for (const chunk of chunks)
        await new Promise<void>((resolve, reject) =>
          socket!.write(chunk, (error) => (error ? reject(error) : resolve())),
        )
    },
    end: () => socket!.end(),
    destroy: () => socket!.destroy(),
    error: () => socket!.destroy(new Error("scripted daemon error")),
    close: async () => {
      socket?.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(path, { force: true })
    },
  }
}

test("explicit client requires a socket", async () => {
  await expect(
    createMusicSessionClient({
      socketPath: "",
      clientId: "x",
      hostKind: "test",
    }),
  ).rejects.toBeInstanceOf(MusicSessionClientError)
})

test("malformed negotiated hello result fails once and destroys the socket", async () => {
  const path = `/tmp/music-session-client-invalid-${process.pid}-${randomUUID()}.sock`
  let server: net.Server | undefined
  let closed: Promise<void> | undefined
  try {
    server = net.createServer((socket) => {
      closed = new Promise((resolve) => socket.once("close", resolve))
      socket.once("data", () =>
        socket.write(
          `${JSON.stringify({
            type: "response",
            requestId: 0,
            ok: true,
            data: {
              daemonInstanceId: "daemon",
              packageVersion: "test",
              protocol: {
                major: 1,
                minRevision: 0,
                maxRevision: 1,
                selectedRevision: 2,
              },
              capabilities: ["state-replay"],
            },
          })}\n`,
        ),
      )
    })
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject)
      server!.listen(path, resolve)
    })
    await expect(
      createMusicSessionClient({
        socketPath: path,
        clientId: "invalid-result",
        hostKind: "test",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    await closed
  } finally {
    await new Promise<void>(
      (resolve) => server?.close(() => resolve()) ?? resolve(),
    )
    await rm(path, { force: true })
  }
})

test("hello failure response and malformed frame destroy the client socket", async () => {
  for (const [name, frame, expectedCode] of [
    [
      "failure",
      JSON.stringify({
        type: "response",
        requestId: 0,
        ok: false,
        error: {
          code: "UNSUPPORTED_CAPABILITY",
          message: "state-replay capability is required",
          retryable: false,
        },
      }),
      "UNSUPPORTED_CAPABILITY",
    ],
    ["malformed", "not json", "CONNECTION_LOST"],
  ] as const) {
    const path = `/tmp/music-session-client-${name}-${process.pid}-${randomUUID()}.sock`
    let server: net.Server | undefined
    let closed: Promise<void> | undefined
    try {
      server = net.createServer((socket) => {
        closed = new Promise((resolve) => socket.once("close", resolve))
        socket.once("data", () => socket.write(`${frame}\n`))
      })
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject)
        server!.listen(path, resolve)
      })
      await expect(
        createMusicSessionClient({
          socketPath: path,
          clientId: name,
          hostKind: "test",
        }),
      ).rejects.toMatchObject({ code: expectedCode })
      await closed
    } finally {
      await new Promise<void>(
        (resolve) => server?.close(() => resolve()) ?? resolve(),
      )
      await rm(path, { force: true })
    }
  }
})

test("impossible negotiated capabilities destroy the client socket", async () => {
  for (const capabilities of [["state-replay", "future"], ["transport"]]) {
    const path = `/tmp/music-session-client-capabilities-${process.pid}-${randomUUID()}.sock`
    let server: net.Server | undefined
    let closed: Promise<void> | undefined
    try {
      server = net.createServer((socket) => {
        closed = new Promise((resolve) => socket.once("close", resolve))
        socket.once("data", () =>
          socket.write(
            `${JSON.stringify({
              type: "response",
              requestId: 0,
              ok: true,
              data: {
                daemonInstanceId: "daemon",
                packageVersion: "test",
                protocol: {
                  major: 1,
                  minRevision: 0,
                  maxRevision: 1,
                  selectedRevision: 1,
                },
                capabilities,
              },
            })}\n`,
          ),
        )
      })
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject)
        server!.listen(path, resolve)
      })
      await expect(
        createMusicSessionClient({
          socketPath: path,
          clientId: "bad-capabilities",
          hostKind: "test",
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
      await closed
    } finally {
      await new Promise<void>(
        (resolve) => server?.close(() => resolve()) ?? resolve(),
      )
      await rm(path, { force: true })
    }
  }
})

test("out-of-order transport responses settle only their matching command", async () => {
  const path = `/tmp/music-session-client-requests-${process.pid}-${randomUUID()}.sock`
  let server: net.Server | undefined
  let socket: net.Socket | undefined
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  const commands: Array<{ requestId: number; action: string }> = []
  let resolveCommands: () => void = () => {}
  const receivedCommands = new Promise<void>((resolve) => {
    resolveCommands = resolve
  })
  try {
    server = net.createServer((accepted) => {
      socket = accepted
      const framer = new NdjsonFramer()
      accepted.on("data", (chunk) => {
        for (const frame of framer.push(chunk) as Array<{
          type: string
          requestId: number
          action?: string
        }>) {
          if (frame.type === "hello")
            accepted.write(
              `${JSON.stringify({ type: "response", requestId: 0, ok: true, data: { daemonInstanceId: "daemon", packageVersion: "test", protocol: { major: 1, minRevision: 0, maxRevision: 1, selectedRevision: 1 }, capabilities: ["state-replay", "transport"] } })}\n`,
            )
          else if (frame.type === "transport") {
            commands.push({ requestId: frame.requestId, action: frame.action! })
            if (commands.length === 2) resolveCommands()
            if (commands.length === 3)
              accepted.write(
                `${JSON.stringify({
                  type: "response",
                  requestId: frame.requestId,
                  ok: true,
                  data: { action: "play" },
                })}\n`,
              )
          }
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject)
      server!.listen(path, resolve)
    })
    client = await createMusicSessionClient({
      socketPath: path,
      clientId: "requests",
      hostKind: "test",
    })
    await expect(client.seek(-1)).rejects.toMatchObject({
      code: "INVALID_SEEK",
    })
    const play = client.play()
    const pause = client.pause()
    await receivedCommands
    for (const command of [...commands].reverse())
      socket!.write(
        `${JSON.stringify({ type: "response", requestId: command.requestId, ok: true, data: { action: command.action } })}\n`,
      )
    await expect(play).resolves.toEqual({ action: "play" })
    await expect(pause).resolves.toEqual({ action: "pause" })
    await expect(client.next()).rejects.toMatchObject({
      code: "INDETERMINATE_COMMAND",
    })
    await expect(client.play()).rejects.toMatchObject({
      code: "CONNECTION_LOST",
    })
  } finally {
    client?.dispose()
    socket?.destroy()
    await new Promise<void>(
      (resolve) => server?.close(() => resolve()) ?? resolve(),
    )
    await rm(path, { force: true })
  }
})

test("unsolicited and duplicate responses cannot settle later requests", async () => {
  const daemon = await startScriptedDaemon()
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "duplicates",
      hostKind: "test",
    })
    await daemon.accepted()
    await daemon.received(1)
    daemon.send({
      type: "response",
      requestId: 99,
      ok: true,
      data: { action: "play" },
    })
    const play = client.play()
    await daemon.received(2)
    daemon.send({
      type: "response",
      requestId: 1,
      ok: true,
      data: { action: "play" },
    })
    await expect(play).resolves.toEqual({ action: "play" })
    daemon.send({
      type: "response",
      requestId: 1,
      ok: true,
      data: { action: "play" },
    })
    const pause = client.pause()
    await daemon.received(3)
    daemon.send({
      type: "response",
      requestId: 2,
      ok: true,
      data: { action: "pause" },
    })
    await expect(pause).resolves.toEqual({ action: "pause" })
  } finally {
    client?.dispose()
    await daemon.close()
  }
})

test("typed command failures are request-local and disposal is terminal", async () => {
  const daemon = await startScriptedDaemon()
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "failure",
      hostKind: "test",
    })
    await daemon.accepted()
    await daemon.received(1)
    const failed = client.play()
    await daemon.received(2)
    daemon.send({
      type: "response",
      requestId: 1,
      ok: false,
      error: {
        code: "INCOMPATIBLE_PROTOCOL",
        message: "no player",
        retryable: false,
        details: {
          client: { major: 1, minRevision: 0, maxRevision: 1 },
          daemon: { major: 2, minRevision: 0, maxRevision: 1 },
        },
      },
    })
    await expect(failed).rejects.toMatchObject({
      code: "INCOMPATIBLE_PROTOCOL",
      message: "no player",
      retryable: false,
      details: {
        client: { major: 1, minRevision: 0, maxRevision: 1 },
        daemon: { major: 2, minRevision: 0, maxRevision: 1 },
      },
    })
    const pause = client.pause()
    await daemon.received(3)
    daemon.send({
      type: "response",
      requestId: 2,
      ok: true,
      data: { action: "pause" },
    })
    await expect(pause).resolves.toEqual({ action: "pause" })
    const pending = client.next()
    await daemon.received(4)
    client.dispose()
    client.dispose()
    await expect(pending).rejects.toMatchObject({ code: "DISPOSED" })
    await expect(client.play()).rejects.toMatchObject({ code: "DISPOSED" })
  } finally {
    client?.dispose()
    await daemon.close()
  }
})

test("state authority and listener isolation retain only ordered daemon snapshots", async () => {
  const daemon = await startScriptedDaemon()
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  const snapshot = (daemonInstanceId: string, revision: number) => ({
    type: "state",
    snapshot: {
      daemonInstanceId,
      revision,
      state: {
        is_playing: false,
        progress_ms: revision,
        shuffle: false,
        repeat: "off",
        device: null,
        track: null,
        fetched_at: revision,
      },
    },
  })
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "state",
      hostKind: "test",
    })
    await daemon.accepted()
    await daemon.received(1)
    const seen: number[] = []
    let resolveDelivered: () => void = () => {}
    const delivered = new Promise<void>(
      (resolve) => (resolveDelivered = resolve),
    )
    client.subscribeState(() => {
      throw new Error("listener defect")
    })
    const unsubscribe = client.subscribeState((state) => {
      seen.push(state.revision)
      if (state.revision === 5) resolveDelivered()
    })
    daemon.send(snapshot("daemon", 1))
    daemon.send(snapshot("daemon", 1))
    daemon.send(snapshot("daemon", 0))
    daemon.send(snapshot("other", 2))
    daemon.send(snapshot("daemon", 3))
    daemon.send(snapshot("daemon", 5))
    daemon.send(snapshot("daemon", 4))
    await delivered
    expect(seen).toEqual([1, 3, 5])
    expect(client.state?.revision).toBe(5)
    unsubscribe()
    unsubscribe()
    const late: number[] = []
    let resolveLate: () => void = () => {}
    const deliveredLate = new Promise<void>(
      (resolve) => (resolveLate = resolve),
    )
    client.subscribeState((state) => {
      late.push(state.revision)
      if (state.revision === 6) resolveLate()
    })
    expect(late).toEqual([5])
    daemon.send(snapshot("daemon", 6))
    await deliveredLate
    expect(seen).toEqual([1, 3, 5])
    expect(late).toEqual([5, 6])
  } finally {
    client?.dispose()
    await daemon.close()
  }
})

test("connection loss races leave every admitted command indeterminate without replay", async () => {
  const daemon = await startScriptedDaemon()
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "loss",
      hostKind: "test",
    })
    await daemon.accepted()
    await daemon.received(1)
    const play = client.play()
    const pause = client.pause()
    const frames = await daemon.received(3)
    expect(frames.map((frame) => frame.type)).toEqual([
      "hello",
      "transport",
      "transport",
    ])
    const outcomes = Promise.all(
      [play, pause].map((command) =>
        command.then(
          () => undefined,
          (error: unknown) => error,
        ),
      ),
    )
    daemon.end()
    await expect(outcomes).resolves.toEqual([
      expect.objectContaining({ code: "INDETERMINATE_COMMAND" }),
      expect.objectContaining({ code: "INDETERMINATE_COMMAND" }),
    ])
    daemon.error()
    await daemon.closed()
    await expect(client.next()).rejects.toMatchObject({
      code: "CONNECTION_LOST",
    })
    expect(daemon.frames()).toEqual(frames)
    expect(daemon.connections()).toBe(1)
  } finally {
    client?.dispose()
    await daemon.close()
  }
})

test("malformed transport success terminates only after indeterminate settlement", async () => {
  const daemon = await startScriptedDaemon()
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "malformed-result",
      hostKind: "test",
    })
    await daemon.received(1)
    const pending = client.play()
    await daemon.received(2)
    daemon.send({ type: "response", requestId: 1, ok: true, data: {} })
    await expect(pending).rejects.toMatchObject({
      code: "INDETERMINATE_COMMAND",
    })
    await expect(client.pause()).rejects.toMatchObject({
      code: "CONNECTION_LOST",
    })
  } finally {
    client?.dispose()
    await daemon.close()
  }
})

test("active malformed daemon data terminates once without publishing late frames", async () => {
  const state = (revision: number) => ({
    type: "state",
    snapshot: {
      daemonInstanceId: "daemon",
      revision,
      state: {
        is_playing: false,
        progress_ms: revision,
        shuffle: false,
        repeat: "off",
        device: null,
        track: null,
        fetched_at: revision,
      },
    },
  })
  const cases: ReadonlyArray<
    readonly [string, (daemon: ScriptedDaemon) => Promise<void>]
  > = [
    [
      "malformed nested status",
      (daemon) =>
        daemon.write(
          `${JSON.stringify({ type: "status", status: { kind: "ready", provider: "media-control", message: 1 } })}\n${JSON.stringify({ type: "status", status: { kind: "ready", provider: "media-control", message: "late" } })}\n`,
        ),
    ],
    [
      "malformed nested state",
      (daemon) =>
        daemon.write(
          `${JSON.stringify({ type: "state", snapshot: { ...state(2).snapshot, state: { ...state(2).snapshot.state, progress_ms: "bad" } } })}\n${JSON.stringify(state(3))}\n`,
        ),
    ],
    [
      "malformed ndjson",
      (daemon) => daemon.write(`not json\n${JSON.stringify(state(2))}\n`),
    ],
    [
      "partial frame at eof",
      async (daemon) => {
        await daemon.write('{"type":"status"')
        daemon.end()
      },
    ],
  ]
  for (const [name, injectMalformedData] of cases) {
    const daemon = await startScriptedDaemon()
    let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
    try {
      client = await createMusicSessionClient({
        socketPath: daemon.path,
        clientId: `invalid-active-${name}`,
        hostKind: "test",
      })
      await daemon.received(1)
      const states: number[] = []
      const statuses: string[] = []
      let resolveState: () => void = () => {}
      let resolveStatus: () => void = () => {}
      const deliveredState = new Promise<void>((resolve) => {
        resolveState = resolve
      })
      const deliveredStatus = new Promise<void>((resolve) => {
        resolveStatus = resolve
      })
      client.subscribeState((snapshot) => {
        states.push(snapshot.revision)
        resolveState()
      })
      client.subscribeStatus((status) => {
        statuses.push(status.message)
        resolveStatus()
      })
      daemon.send(state(1))
      await deliveredState
      daemon.send({
        type: "status",
        status: { kind: "ready", provider: "media-control", message: "before" },
      })
      await deliveredStatus
      const pending = client.play()
      await daemon.received(2)
      await injectMalformedData(daemon)
      await expect(pending).rejects.toMatchObject({
        code: "INDETERMINATE_COMMAND",
      })
      await daemon.closed()
      await expect(client.pause()).rejects.toMatchObject({
        code: "CONNECTION_LOST",
      })
      client.subscribeState((snapshot) => states.push(snapshot.revision))
      client.subscribeStatus((status) => statuses.push(status.message))
      expect(client.state?.revision).toBe(1)
      expect(client.status?.message).toBe("before")
      expect(states).toEqual([1])
      expect(statuses).toEqual(["before"])
    } finally {
      client?.dispose()
      await daemon.close()
    }
  }
})

test("disposal wins first and suppresses late daemon callbacks", async () => {
  const daemon = await startScriptedDaemon()
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  const state = (revision: number) => ({
    type: "state",
    snapshot: {
      daemonInstanceId: "daemon",
      revision,
      state: {
        is_playing: false,
        progress_ms: revision,
        shuffle: false,
        repeat: "off",
        device: null,
        track: null,
        fetched_at: revision,
      },
    },
  })
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "dispose-first",
      hostKind: "test",
    })
    await daemon.received(1)
    const states: number[] = []
    const statuses: string[] = []
    let resolveInitialState: () => void = () => {}
    let resolveInitialStatus: () => void = () => {}
    const initialState = new Promise<void>((resolve) => {
      resolveInitialState = resolve
    })
    const initialStatus = new Promise<void>((resolve) => {
      resolveInitialStatus = resolve
    })
    client.subscribeState((snapshot) => {
      states.push(snapshot.revision)
      resolveInitialState()
    })
    client.subscribeStatus((status) => {
      statuses.push(status.message)
      resolveInitialStatus()
    })
    daemon.send(state(1))
    await initialState
    daemon.send({
      type: "status",
      status: { kind: "ready", provider: "media-control", message: "before" },
    })
    await initialStatus
    const pending = client.play()
    await daemon.received(2)
    client.dispose()
    client.dispose()
    daemon.send({
      type: "response",
      requestId: 1,
      ok: true,
      data: { action: "play" },
    })
    void daemon
      .write(
        `${JSON.stringify(state(2))}\n${JSON.stringify({ type: "status", status: { kind: "ready", provider: "media-control", message: "after" } })}\n`,
      )
      .catch(() => {})
    daemon.error()
    daemon.end()
    daemon.destroy()
    await expect(pending).rejects.toMatchObject({ code: "DISPOSED" })
    await daemon.closed()
    await expect(client.pause()).rejects.toMatchObject({ code: "DISPOSED" })
    expect(client.state?.revision).toBe(1)
    expect(client.status?.message).toBe("before")
    expect(states).toEqual([1])
    expect(statuses).toEqual(["before"])
    expect(daemon.connections()).toBe(1)
  } finally {
    client?.dispose()
    await daemon.close()
  }
})

test("split and multiple status frames isolate listeners and retain command use", async () => {
  const daemon = await startScriptedDaemon()
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "frames",
      hostKind: "test",
    })
    await daemon.received(1)
    const statuses: string[] = []
    const allStatuses: string[] = []
    let resolveStatuses: () => void = () => {}
    const delivered = new Promise<void>(
      (resolve) => (resolveStatuses = resolve),
    )
    let unsubscribe: () => void = () => {}
    unsubscribe = client.subscribeStatus((status) => {
      statuses.push(status.message)
      unsubscribe()
    })
    client.subscribeStatus(() => {
      throw new Error("listener defect")
    })
    client.subscribeStatus((status) => {
      allStatuses.push(status.message)
      if (status.message === "three") resolveStatuses()
    })
    const one = JSON.stringify({
      type: "status",
      status: { kind: "ready", provider: "media-control", message: "one" },
    })
    const two = JSON.stringify({
      type: "status",
      status: { kind: "ready", provider: "media-control", message: "two" },
    })
    const three = JSON.stringify({
      type: "status",
      status: { kind: "ready", provider: "media-control", message: "three" },
    })
    await daemon.write(one.slice(0, 9), `${one.slice(9)}\n`)
    await daemon.write(`${two}\n${three}\n`)
    await delivered
    expect(statuses).toEqual(["one"])
    expect(allStatuses).toEqual(["one", "two", "three"])
    const play = client.play()
    await daemon.received(2)
    daemon.send({
      type: "response",
      requestId: 1,
      ok: true,
      data: { action: "play" },
    })
    await expect(play).resolves.toEqual({ action: "play" })
  } finally {
    client?.dispose()
    await daemon.close()
  }
})

test("hello chunk status survives the active-reader transition", async () => {
  const helloStatus = `${JSON.stringify({ type: "status", status: { kind: "ready", provider: "media-control", message: "hello" } })}\n`
  const daemon = await startScriptedDaemon(helloStatus)
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "handoff",
      hostKind: "test",
    })
    await daemon.received(1)
    expect(client.status?.message).toBe("hello")
    const replayed: string[] = []
    client.subscribeStatus((status) => replayed.push(status.message))
    expect(replayed).toEqual(["hello"])
  } finally {
    client?.dispose()
    await daemon.close()
  }
})

test("explicit client exposes current negotiated revision and capabilities", async () => {
  const path = `/tmp/music-session-client-${process.pid}-${randomUUID()}.sock`
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    server = await startMusicSessionServer(
      { socketPath: path },
      createFakeProvider(),
    )
    client = await createMusicSessionClient({
      socketPath: path,
      clientId: "current",
      hostKind: "test",
    })
    expect(client.selectedRevision).toBe(1)
    expect(client.negotiatedCapabilities).toEqual(["state-replay", "transport"])
  } finally {
    client?.dispose()
    await server?.close().catch(() => {})
  }
})
