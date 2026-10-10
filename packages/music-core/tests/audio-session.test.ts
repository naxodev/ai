import { expect, test as baseTest } from "bun:test"
import { testUnixSession as test } from "./unix-session.ts"
import { randomUUID } from "node:crypto"
import net from "node:net"
import { Effect, Exit, Latch, Queue, Ref, Schema, Scope, Stream } from "effect"
import { localMonotonicMs } from "../audio/clock.ts"
import {
  layerFromAdapters,
  type AudioCaptureAdapter,
} from "../audio/capture.ts"
import {
  audioVisualizationCapability,
  audioInterestLeaseCapability,
  emptyPlayer,
  baselineCapabilities,
  PROTOCOL,
} from "../index.ts"
import {
  createMusicSessionClient,
  createReconnectingMusicSessionClientEffect,
  MusicSessionClientError,
  type MusicSessionClient,
  type AudioFeatureUpdate,
} from "../session/client.ts"
import { NdjsonFramer } from "../session/framing.ts"
import {
  createFakeProvider,
  startMusicSessionServer,
} from "../session/server.ts"
import { AudioSourceList, type ResolvedCaptureSource } from "../audio/schema.ts"

const socketPath = (name: string) =>
  `/tmp/music-audio-${name}-${process.pid}-${randomUUID()}.sock`

const source = (): ResolvedCaptureSource => ({
  mode: "process",
  label: "Player",
  observationSequence: 1,
  capabilities: {
    spectrum: "measured",
    envelope: "absent",
    channels: "absent",
  },
  identity: {
    kind: "native",
    processIdentifier: 42,
    launchIdentity: "boot-1",
    executableIdentity: "player",
    coreAudioObject: "tap-1",
  },
})

const audioClient = (
  path: string,
  clientId: string,
  capabilities = [...baselineCapabilities, audioVisualizationCapability],
) =>
  createMusicSessionClient({
    socketPath: path,
    clientId,
    hostKind: "test",
    capabilities,
  })

const holdAdapter = (
  nowMs: () => number = localMonotonicMs,
  interestLeaseMs = 5_000,
) =>
  Effect.gen(function* () {
    const starts = yield* Ref.make(0)
    const releases = yield* Ref.make(0)
    const entered = yield* Latch.make(false)
    const releaseStart = yield* Latch.make(false)
    const frames = yield* Queue.unbounded<{
      readonly timestampMs: number
      readonly sampleAgeMs: number
      readonly clockDomain: "capture-monotonic"
      readonly spectrum: readonly number[]
    }>()
    const adapter: AudioCaptureAdapter = {
      availability: "available",
      start: () =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            yield* Ref.update(starts, (count) => count + 1)
            yield* Latch.open(entered)
            yield* Latch.await(releaseStart)
            return {
              frames: Stream.unfold(undefined, () =>
                Queue.take(frames).pipe(
                  Effect.map((item) => [item, undefined] as const),
                ),
              ),
            }
          }),
          () => Ref.update(releases, (count) => count + 1),
        ),
    }
    const layer = (daemonInstanceId: string) =>
      layerFromAdapters({
        daemonInstanceId,
        nowMs,
        interestLeaseMs,
        adapter,
        observations: Stream.never,
        resolver: {
          list: () =>
            Effect.succeed({ availability: "available", sources: [source()] }),
          revalidate: (current) => Effect.succeed(current),
          confirm: () => Effect.succeed("same"),
        },
      })
    return { adapter, layer, starts, releases, entered, releaseStart, frames }
  })

const readFrames = (socket: net.Socket) => {
  const framer = new NdjsonFramer()
  const frames: unknown[] = []
  socket.on("data", (chunk) => {
    frames.push(...framer.push(chunk))
  })
  return {
    frames,
    next: (predicate: (frame: Record<string, unknown>) => boolean) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for frame")),
          2_000,
        )
        const poll = () => {
          const found = frames.find(
            (frame): frame is Record<string, unknown> =>
              typeof frame === "object" &&
              frame !== null &&
              predicate(frame as Record<string, unknown>),
          )
          if (found) {
            clearTimeout(timer)
            resolve(found)
            return
          }
          setTimeout(poll, 5)
        }
        poll()
      }),
  }
}

baseTest(
  "audio capability is absent from baseline so current hosts do not opt in",
  () => {
    expect(baselineCapabilities).not.toContain(audioVisualizationCapability)
    expect(PROTOCOL.maxRevision).toBe(2)
  },
)

test("opted-in client receives truthful unavailable capture and playback still works", async () => {
  const path = socketPath("unavailable")
  const server = await startMusicSessionServer(
    { socketPath: path },
    createFakeProvider(),
  )
  const client = await audioClient(path, "opted-in")
  try {
    expect(client.selectedRevision).toBe(2)
    expect(client.negotiatedCapabilities).toContain(
      audioVisualizationCapability,
    )
    expect(await client.listAudioSources()).toMatchObject({
      availability: "unavailable",
      reason: "capture-adapter-unavailable",
    })
    expect(await client.play()).toEqual({ action: "play" })
  } finally {
    client.dispose()
    await server.close()
  }
})

test("old clients negotiate without audio capability and receive no audio frames", async () => {
  const path = socketPath("old-client")
  const daemonNow = () => 50_000
  const probe = await Effect.runPromise(holdAdapter(daemonNow))
  await Effect.runPromise(Latch.open(probe.releaseStart))
  const server = await startMusicSessionServer(
    { socketPath: path },
    createFakeProvider(),
    { audioNowMs: daemonNow },
    probe.layer,
  )
  const legacy = net.connect(path)
  const reader = readFrames(legacy)
  const current = await createMusicSessionClient({
    socketPath: path,
    clientId: "current",
    hostKind: "test",
    capabilities: [...baselineCapabilities, audioVisualizationCapability],
    monotonicNow: () => 100,
  })
  try {
    legacy.write(
      `${JSON.stringify({
        type: "hello",
        requestId: 0,
        protocol: { major: 1, minRevision: 0, maxRevision: 1 },
        packageVersion: "old",
        clientId: "old",
        hostKind: "test",
        capabilities: [...baselineCapabilities, audioVisualizationCapability],
      })}\n`,
    )
    const hello = await reader.next(
      (frame) => frame.type === "response" && frame.requestId === 0,
    )
    expect(hello).toMatchObject({
      ok: true,
      data: {
        protocol: { selectedRevision: 1 },
        capabilities: expect.not.arrayContaining([
          audioVisualizationCapability,
        ]),
      },
    })
    const listed = await current.listAudioSources()
    const token = listed.sources[0]?.token
    if (!token) throw new Error("missing token")
    expect((await current.startAudioCapture(token)).type).toBe("started")
    const received = new Promise<unknown>((resolve) => {
      current.subscribeAudioFeatures((frame) => resolve(frame))
    })
    await Effect.runPromise(
      Queue.offer(probe.frames, {
        timestampMs: 50_000,
        sampleAgeMs: 0,
        clockDomain: "capture-monotonic",
        spectrum: [0],
      }),
    )
    const feature = await received
    expect(feature).toMatchObject({
      daemonInstanceId: current.daemonInstanceId,
      sequence: 1,
    })
    expect(
      reader.frames.some((frame) => {
        return (
          typeof frame === "object" &&
          frame !== null &&
          "type" in frame &&
          (frame.type === "audio-status" || frame.type === "audio-features")
        )
      }),
    ).toBe(false)
    expect(await current.play()).toEqual({ action: "play" })
  } finally {
    legacy.destroy()
    current.dispose()
    await server.close()
  }
})

test("blocked audio start does not delay Play on the same connection", async () => {
  const path = socketPath("blocked-start")
  const probe = await Effect.runPromise(holdAdapter())
  const server = await startMusicSessionServer(
    { socketPath: path },
    createFakeProvider(),
    {},
    probe.layer,
  )
  const client = await audioClient(path, "blocked")
  try {
    const listed = await client.listAudioSources()
    const token = listed.sources[0]?.token
    if (!token) throw new Error("missing token")
    const pending = client.startAudioCapture(token)
    await Effect.runPromise(Latch.await(probe.entered))
    expect(await client.play()).toEqual({ action: "play" })
    await Effect.runPromise(Latch.open(probe.releaseStart))
    expect((await pending).type).toBe("started")
  } finally {
    client.dispose()
    await server.close()
  }
})

test("a blocked writer preserves expiry before a cached admission and newer unjoined presentation", async () => {
  const path = socketPath("blocked-expiry-evidence")
  let now = 0
  const probe = await Effect.runPromise(holdAdapter(() => now))
  await Effect.runPromise(Latch.open(probe.releaseStart))
  const sockets: net.Socket[] = []
  const idle = Promise.withResolvers<void>()
  const blocked = Promise.withResolvers<void>()
  const expiredQueued = Promise.withResolvers<void>()
  const newerQueued = Promise.withResolvers<void>()
  const newerReceived = Promise.withResolvers<void>()
  let blockNext = false
  let heldWrite: (() => void) | undefined
  const awaitGate = (promise: Promise<void>) =>
    Effect.runPromise(
      Effect.promise(() => promise).pipe(Effect.timeout("2 seconds")),
    )
  const server = await startMusicSessionServer(
    { socketPath: path },
    createFakeProvider(),
    {
      audioNowMs: () => now,
      onAccepted: (socket) => sockets.push(socket),
      onWriteAttempt: (socket) => {
        if (!blockNext || socket !== sockets[0]) return
        blockNext = false
        const original = socket.write
        socket.write = (
          chunk,
          encodingOrCallback?:
            BufferEncoding | ((error?: Error | null) => void),
          callback?: (error?: Error | null) => void,
        ) => {
          socket.write = original
          heldWrite = () => {
            if (typeof encodingOrCallback === "function")
              original.call(socket, chunk, undefined, encodingOrCallback)
            else original.call(socket, chunk, encodingOrCallback, callback)
          }
          return false
        }
      },
      onWriterBlocked: (socket) => {
        if (socket === sockets[0]) blocked.resolve()
      },
      onAudioStatusQueued: (socket, status) => {
        if (socket !== sockets[0]) return
        if (status.type === "stopped" && status.reason === "lease-expired")
          expiredQueued.resolve()
        if (status.type === "active" && status.generation === 2)
          newerQueued.resolve()
      },
    },
    probe.layer,
  )
  const first = await audioClient(path, "blocked-expiry")
  let second: MusicSessionClient | undefined
  let pending: ReturnType<MusicSessionClient["startAudioCapture"]> | undefined
  const statuses: unknown[] = []
  first.subscribeAudioStatus((status) => {
    statuses.push(status)
    if (status.type === "idle") idle.resolve()
    if (status.type === "active" && status.generation === 2)
      newerReceived.resolve()
  })
  try {
    await awaitGate(idle.promise)
    const token = (await first.listAudioSources()).sources[0]?.token
    if (!token) throw new Error("missing first token")
    blockNext = true
    pending = first.startAudioCapture(token)
    await awaitGate(blocked.promise)
    now = 6_000
    await awaitGate(expiredQueued.promise)
    expect(await Effect.runPromise(Ref.get(probe.releases))).toBe(1)
    second = await audioClient(path, "healthy-after-expiry")
    const secondToken = (await second.listAudioSources()).sources[0]?.token
    if (!secondToken) throw new Error("missing second token")
    expect(await second.startAudioCapture(secondToken)).toMatchObject({
      type: "started",
      generation: 2,
    })
    await awaitGate(newerQueued.promise)
    heldWrite?.()
    heldWrite = undefined
    sockets[0]?.emit("drain")
    expect(await pending).toMatchObject({ type: "started", generation: 1 })
    await awaitGate(newerReceived.promise)
    expect(await first.play()).toEqual({ action: "play" })
    const freshToken = (await first.listAudioSources()).sources[0]?.token
    if (!freshToken) throw new Error("missing fresh token")
    await expect(first.startAudioCapture(freshToken)).rejects.toThrow(
      "fresh connection",
    )
    expect(statuses).toContainEqual({
      type: "stopped",
      generation: 1,
      reason: "lease-expired",
    })
    expect(await second.play()).toEqual({ action: "play" })
  } finally {
    const settled = Promise.allSettled(pending ? [pending] : [])
    first.dispose()
    second?.dispose()
    sockets[0]?.emit("drain")
    await settled
    await server.close()
  }
})

test("an older revision-2 audio client expires on a new daemon while its socket and metadata playback remain usable", async () => {
  const path = socketPath("unrenewed-old-audio")
  const probe = await Effect.runPromise(holdAdapter(localMonotonicMs, 100))
  await Effect.runPromise(Latch.open(probe.releaseStart))
  const server = await startMusicSessionServer(
    { socketPath: path },
    createFakeProvider(),
    {},
    probe.layer,
  )
  const socket = net.connect(path)
  const reader = readFrames(socket)
  const metadata = await createMusicSessionClient({
    socketPath: path,
    clientId: "metadata-only",
    hostKind: "test",
  })
  const send = (frame: unknown) => socket.write(`${JSON.stringify(frame)}\n`)
  try {
    send({
      type: "hello",
      requestId: 0,
      protocol: PROTOCOL,
      packageVersion: "old-audio",
      clientId: "old-audio",
      hostKind: "test",
      capabilities: [...baselineCapabilities, audioVisualizationCapability],
    })
    const hello = await reader.next(
      (frame) => frame.type === "response" && frame.requestId === 0,
    )
    expect(hello).toMatchObject({
      ok: true,
      data: {
        capabilities: expect.not.arrayContaining([
          audioInterestLeaseCapability,
        ]),
      },
    })
    send({ type: "audio-subscribe", requestId: 1, channel: "status" })
    send({ type: "audio-sources", requestId: 2 })
    const listed = await reader.next(
      (frame) => frame.type === "response" && frame.requestId === 2,
    )
    const decoded = Schema.decodeUnknownSync(AudioSourceList)(listed.data)
    const token = decoded.sources[0]?.token
    if (!token) throw new Error("missing old-client selection")
    send({ type: "audio-start", requestId: 3, token })
    expect(
      await reader.next(
        (frame) => frame.type === "response" && frame.requestId === 3,
      ),
    ).toMatchObject({ ok: true, data: { type: "started" } })
    await reader.next(
      (frame) =>
        frame.type === "audio-status" &&
        typeof frame.status === "object" &&
        frame.status !== null &&
        "reason" in frame.status &&
        frame.status.reason === "lease-expired",
    )
    expect(await Effect.runPromise(Ref.get(probe.releases))).toBe(1)
    expect(socket.destroyed).toBe(false)
    expect(await metadata.play()).toEqual({ action: "play" })
    send({ type: "state", requestId: 4 })
    expect(
      await reader.next(
        (frame) => frame.type === "response" && frame.requestId === 4,
      ),
    ).toMatchObject({ ok: true })
  } finally {
    socket.destroy()
    metadata.dispose()
    await server.close()
  }
})

test("unsupported audio requests do not terminate playback", async () => {
  const path = socketPath("unsupported")
  const server = await startMusicSessionServer(
    { socketPath: path },
    createFakeProvider(),
  )
  const client = await createMusicSessionClient({
    socketPath: path,
    clientId: "no-audio",
    hostKind: "test",
  })
  const raw = net.connect(path)
  const reader = readFrames(raw)
  try {
    raw.write(
      `${JSON.stringify({
        type: "hello",
        requestId: 0,
        protocol: PROTOCOL,
        packageVersion: "test",
        clientId: "raw-no-audio",
        hostKind: "test",
        capabilities: [...baselineCapabilities],
      })}\n`,
    )
    await reader.next((frame) => frame.type === "response" && frame.ok === true)
    raw.write(
      `${JSON.stringify({ type: "audio-start", requestId: 1, token: "sel_nope" })}\n`,
    )
    expect(
      await reader.next(
        (frame) => frame.type === "response" && frame.requestId === 1,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_CAPABILITY" },
    })
    expect(await client.play()).toEqual({ action: "play" })
  } finally {
    raw.destroy()
    client.dispose()
    await server.close()
  }
})

test("reconnect does not replay Start or grant replacement consent", async () => {
  const starts: string[] = []
  let active: MusicSessionClient | undefined
  const first = DeferredClient()
  const second = DeferredClient()
  const scope = await Effect.runPromise(Scope.make())
  const managed = await Effect.runPromise(
    createReconnectingMusicSessionClientEffect(
      { clientId: "reconnect-audio", hostKind: "test" },
      {
        connect: () => {
          const next = active ? second.client : first.client
          active = next
          return Effect.succeed(next)
        },
      },
    ).pipe(Effect.provideService(Scope.Scope, scope)),
  )
  const pending = managed.startAudioCapture("sel_old")
  first.failStart()
  await expect(pending).rejects.toMatchObject({
    code: "INDETERMINATE_COMMAND",
  })
  expect(starts).toEqual(["sel_old"])
  expect(second.starts).toEqual([])
  await Effect.runPromise(Scope.close(scope, Exit.void))

  function DeferredClient() {
    const localStarts: string[] = []
    let rejectStart: (() => void) | undefined
    let rejectPending: ((error: MusicSessionClientError) => void) | undefined
    const client = {
      daemonInstanceId: "daemon",
      negotiatedCapabilities: [
        ...baselineCapabilities,
        audioVisualizationCapability,
      ],
      selectedRevision: 2,
      get status() {
        return undefined
      },
      get state() {
        return undefined
      },
      subscribeStatus: () => () => {},
      subscribeState: () => () => {},
      subscribeTerminal: (
        listener: (error: MusicSessionClientError) => void,
      ) => {
        rejectStart = () =>
          listener(
            new MusicSessionClientError({
              code: "CONNECTION_LOST",
              message: "connection lost",
              retryable: true,
            }),
          )
        return () => {}
      },
      listAudioSources: async () => ({
        availability: "unavailable" as const,
        reason: "capture-adapter-unavailable" as const,
        sources: [],
      }),
      startAudioCapture: (token: string) => {
        localStarts.push(token)
        starts.push(token)
        return new Promise<never>((_resolve, reject) => {
          rejectPending = reject
        })
      },
      stopAudioCapture: async () => ({
        type: "rejected" as const,
        reason: "not-joined" as const,
      }),
      subscribeAudioStatus: () => () => {},
      subscribeAudioFeatures: () => () => {},
      toggle: async () => ({ action: "toggle" as const }),
      play: async () => ({ action: "play" as const }),
      pause: async () => ({ action: "pause" as const }),
      next: async () => ({ action: "next" as const }),
      previous: async () => ({ action: "previous" as const }),
      seek: async () => ({ action: "seek" as const }),
      artwork: async () => ({ type: "unavailable" as const }),
      dispose: () => {},
      failStart: () => {
        rejectStart?.()
        rejectPending?.(
          new MusicSessionClientError({
            code: "INDETERMINATE_COMMAND",
            message: "audio start outcome is indeterminate after reconnect",
            retryable: true,
          }),
        )
      },
    }
    const session: MusicSessionClient = client
    return { client: session, starts: localStarts, failStart: client.failStart }
  }
})

test("blocked Stop requests stay bounded without blocking Play", async () => {
  const path = socketPath("bounded-stop")
  const closing = Latch.makeUnsafe()
  const release = Latch.makeUnsafe()
  const releases = Ref.makeUnsafe(0)
  const server = await startMusicSessionServer(
    { socketPath: path, mandatoryOutboundQueueCapacity: 4 },
    createFakeProvider(),
    {},
    (daemonInstanceId) =>
      layerFromAdapters({
        daemonInstanceId,
        observations: Stream.never,
        resolver: {
          list: () =>
            Effect.succeed({ availability: "available", sources: [source()] }),
          revalidate: (current) => Effect.succeed(current),
          confirm: () => Effect.succeed("same"),
        },
        adapter: {
          availability: "available",
          start: () =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Latch.open(closing).pipe(
                  Effect.andThen(Latch.await(release)),
                  Effect.andThen(Ref.update(releases, (n) => n + 1)),
                ),
              )
              return { frames: Stream.never }
            }),
        },
      }),
  )
  const client = await audioClient(path, "bounded-stop")
  try {
    const token = (await client.listAudioSources()).sources[0]?.token
    if (!token) throw new Error("missing token")
    await client.startAudioCapture(token)
    const first = client.stopAudioCapture()
    await Effect.runPromise(Latch.await(closing))
    const pending = Promise.all([
      first,
      client.stopAudioCapture(),
      client.stopAudioCapture(),
      client.stopAudioCapture(),
    ])
    expect(await client.play()).toEqual({ action: "play" })
    await expect(client.stopAudioCapture()).rejects.toMatchObject({
      code: "SERVER_BUSY",
    })
    expect(await Effect.runPromise(Ref.get(releases))).toBe(0)
    await Effect.runPromise(Latch.open(release))
    expect((await pending)[0]?.type).toBe("stopped")
    expect(await Effect.runPromise(Ref.get(releases))).toBe(1)
    expect(await client.play()).toEqual({ action: "play" })
  } finally {
    await Effect.runPromise(Latch.open(release))
    client.dispose()
    await server.close()
  }
})

// A scripted peer injects valid but unauthorized frames through the real decoder.
const scriptedAudioPeer = async (
  deterministicExpiry = false,
  leased = false,
  maxPendingRequests = 128,
) => {
  const timers: Array<{
    callback: () => void
    delayMs: number
    canceled: boolean
  }> = []
  const scheduleAudioExpiry = (callback: () => void, delayMs: number) => {
    const timer = { callback, delayMs, canceled: false }
    timers.push(timer)
    return () => {
      timer.canceled = true
    }
  }
  const leaseTimers: typeof timers = []
  const scheduleAudioLease = (callback: () => void, delayMs: number) => {
    const timer = { callback, delayMs, canceled: false }
    leaseTimers.push(timer)
    return () => {
      timer.canceled = true
    }
  }
  const requests: Array<{
    type: unknown
    requestId: unknown
    generation?: unknown
  }> = []
  let renewal: "renewed" | "rejected" | "held" | "failed" = "renewed"
  let clientNow = 100
  let captureGeneration = 1
  let holdStart = false
  let holdStop = false
  let stopRejected = false
  const path = socketPath("scripted")
  let accepted: net.Socket | undefined
  const server = net.createServer((socket) => {
    accepted = socket
    const framer = new NdjsonFramer()
    socket.on("data", (chunk) => {
      for (const frame of framer.push(chunk)) {
        if (
          typeof frame !== "object" ||
          frame === null ||
          !("type" in frame) ||
          !("requestId" in frame)
        )
          continue
        requests.push({
          type: frame.type,
          requestId: frame.requestId,
          ...("generation" in frame ? { generation: frame.generation } : {}),
        })
        if (
          (frame.type === "audio-start" && holdStart) ||
          (frame.type === "audio-stop" && holdStop)
        )
          continue
        if (frame.type === "audio-renew" && renewal === "held") continue
        if (frame.type === "audio-renew" && renewal === "failed") {
          socket.write(
            `${JSON.stringify({ type: "response", requestId: frame.requestId, ok: false, error: { code: "SERVER_BUSY", message: "synthetic renewal failure", retryable: true } })}\n`,
          )
          continue
        }
        const data =
          frame.type === "hello"
            ? {
                daemonInstanceId: "scripted",
                packageVersion: "test",
                protocol: { ...PROTOCOL, selectedRevision: 2 },
                capabilities: [
                  ...baselineCapabilities,
                  audioVisualizationCapability,
                  ...(leased ? [audioInterestLeaseCapability] : []),
                ],
                audioClock: { daemonMonotonicMs: 1_000_000 },
              }
            : frame.type === "audio-sources"
              ? {
                  availability: "available",
                  sources: [
                    {
                      token: "scripted-token",
                      label: "Synthetic player",
                      mode: "process",
                      capabilities: source().capabilities,
                    },
                  ],
                }
              : frame.type === "audio-start"
                ? {
                    type: "started",
                    generation: captureGeneration,
                    source: source().identity,
                  }
                : frame.type === "audio-stop"
                  ? stopRejected
                    ? { type: "rejected", reason: "not-joined" }
                    : {
                        type: "stopped",
                        generation: captureGeneration,
                        reason: "stop",
                      }
                  : frame.type === "audio-renew"
                    ? renewal === "rejected"
                      ? { type: "rejected", reason: "not-joined" }
                      : {
                          type: "renewed",
                          generation:
                            "generation" in frame ? frame.generation : 1,
                        }
                    : frame.type === "transport" && "action" in frame
                      ? { action: frame.action }
                      : {
                          type:
                            frame.type === "audio-subscribe"
                              ? "subscribed"
                              : "unsubscribed",
                          channel:
                            "channel" in frame ? frame.channel : "status",
                        }
        socket.write(
          `${JSON.stringify({ type: "response", requestId: frame.requestId, ok: true, data })}\n`,
        )
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  const client = await createMusicSessionClient({
    socketPath: path,
    clientId: "scripted",
    hostKind: "test",
    capabilities: [...baselineCapabilities, audioVisualizationCapability],
    monotonicNow: () => clientNow,
    scheduleAudioLease,
    maxPendingRequests,
    ...(deterministicExpiry ? { scheduleAudioExpiry } : {}),
  })
  let barrierId = 0
  const send = async (...frames: unknown[]) => {
    const marker = `barrier-${++barrierId}`
    let unsubscribe = () => {}
    const processed = new Promise<void>((resolve) => {
      unsubscribe = client.subscribeStatus((status) => {
        if (status.message === marker) resolve()
      })
    })
    accepted?.write(
      [
        ...frames,
        {
          type: "status",
          status: { kind: "ready", provider: "media-control", message: marker },
        },
      ]
        .map((frame) => `${JSON.stringify(frame)}\n`)
        .join(""),
    )
    await processed
    unsubscribe()
  }
  return {
    client,
    send,
    timers,
    leaseTimers,
    requests,
    setRenewal: (mode: typeof renewal) => {
      renewal = mode
    },
    setNow: (ms: number) => {
      clientNow = ms
    },
    setGeneration: (generation: number) => {
      captureGeneration = generation
    },
    holdStart: (hold: boolean) => {
      holdStart = hold
    },
    holdStop: (hold: boolean) => {
      holdStop = hold
    },
    setStopRejected: (rejected: boolean) => {
      stopRejected = rejected
    },
    close: async () => {
      client.dispose()
      accepted?.destroy()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
    disconnect: () => accepted?.end(),
  }
}

const clientFrame = (sequence: number, timestampMs = 1_000_000) => ({
  daemonInstanceId: "scripted",
  generation: 1,
  sequence,
  timestampMs,
  publishedAtMs: 1_000_000,
  sampleAgeMs: 0,
  clockDomain: "capture-monotonic",
  source: source().identity,
  capabilities: source().capabilities,
  spectrum: [0],
})

test("audio opt-in negotiates safety leases but metadata, selection, and subscription never renew capture", async () => {
  const peer = await scriptedAudioPeer(false, true)
  let unsubscribe = () => {}
  try {
    expect(peer.client.negotiatedCapabilities).toContain(
      audioInterestLeaseCapability,
    )
    await peer.client.listAudioSources()
    unsubscribe = peer.client.subscribeAudioFeatures(() => {})
    await peer.client.play()
    expect(peer.leaseTimers).toHaveLength(0)
    expect(
      peer.requests.filter((request) => request.type === "audio-renew"),
    ).toHaveLength(0)
    await peer.client.startAudioCapture("scripted-token")
    expect(peer.leaseTimers).toHaveLength(1)
    expect(peer.leaseTimers[0]?.delayMs).toBe(1_000)
    peer.leaseTimers[0]?.callback()
    await peer.client.play()
    expect(
      peer.requests.filter((request) => request.type === "audio-renew"),
    ).toEqual([
      { type: "audio-renew", requestId: expect.any(Number), generation: 1 },
    ])
    const armed = peer.leaseTimers.at(-1)
    unsubscribe()
    expect(armed?.canceled).toBe(true)
    armed?.callback()
    await peer.client.play()
    expect(
      peer.requests.filter((request) => request.type === "audio-renew"),
    ).toHaveLength(1)
  } finally {
    unsubscribe()
    await peer.close()
  }
})

test("a held renewal stays one request in flight and times out without retrying capture", async () => {
  const peer = await scriptedAudioPeer(false, true)
  peer.setRenewal("held")
  try {
    await peer.client.startAudioCapture("scripted-token")
    const terminal = new Promise<MusicSessionClientError>((resolve) =>
      peer.client.subscribeTerminal(resolve),
    )
    peer.leaseTimers.at(-1)?.callback()
    await peer.client.play()
    peer.leaseTimers.at(-1)?.callback()
    await peer.client.play()
    expect(
      peer.requests.filter((request) => request.type === "audio-renew"),
    ).toHaveLength(1)
    peer.setNow(5_100)
    const scheduled = peer.leaseTimers.length
    peer.leaseTimers.at(-1)?.callback()
    expect((await terminal).message).toContain("renewal timed out")
    expect(
      peer.requests.filter((request) => request.type === "audio-start"),
    ).toHaveLength(1)
    expect(peer.leaseTimers).toHaveLength(scheduled)
  } finally {
    await peer.close()
  }
})

test("Stop fences a held renewal's late response and never rearms its interest", async () => {
  const peer = await scriptedAudioPeer(false, true)
  peer.setRenewal("held")
  try {
    await peer.client.startAudioCapture("scripted-token")
    peer.leaseTimers.at(-1)?.callback()
    await peer.client.play()
    const renewal = peer.requests.find(
      (request) => request.type === "audio-renew",
    )
    if (!renewal) throw new Error("missing synthetic renewal")
    await peer.client.stopAudioCapture()
    const before = peer.leaseTimers.length
    await peer.send({
      type: "response",
      requestId: renewal.requestId,
      ok: true,
      data: { type: "renewed", generation: 1 },
    })
    peer.leaseTimers.at(-1)?.callback()
    await peer.client.play()
    expect(peer.leaseTimers).toHaveLength(before)
    expect(
      peer.requests.filter((request) => request.type === "audio-renew"),
    ).toHaveLength(1)
  } finally {
    await peer.close()
  }
})

for (const cancellation of ["stop", "source-loss", "unsubscribe"] as const) {
  test(`${cancellation} settles the exact held renewal so later capture cannot exhaust the request budget`, async () => {
    const peer = await scriptedAudioPeer(false, true, 3)
    peer.setRenewal("held")
    const removeStatus = peer.client.subscribeAudioStatus(() => {})
    let removeFeatures = () => {}
    try {
      await peer.client.play()
      for (let cycle = 0; cycle < 3; cycle++) {
        if (cancellation === "unsubscribe") {
          removeFeatures = peer.client.subscribeAudioFeatures(() => {})
          await peer.client.play()
        }
        await peer.client.startAudioCapture("scripted-token")
        peer.leaseTimers.at(-1)?.callback()
        expect(await peer.client.play()).toEqual({ action: "play" })
        if (cancellation === "stop") await peer.client.stopAudioCapture()
        else if (cancellation === "source-loss")
          await peer.send({
            type: "audio-status",
            status: { type: "stopped", generation: 1, reason: "source-loss" },
          })
        else removeFeatures()
        expect(await peer.client.play()).toEqual({ action: "play" })
      }
      expect(
        peer.requests.filter((request) => request.type === "audio-renew"),
      ).toHaveLength(3)
      expect(
        peer.requests.filter((request) => request.type === "audio-start"),
      ).toHaveLength(3)
    } finally {
      removeFeatures()
      removeStatus()
      await peer.close()
    }
  })
}

for (const mode of ["rejected", "failed"] as const) {
  test(`a ${mode} renewal clears local authority without replaying Start`, async () => {
    const peer = await scriptedAudioPeer(false, true)
    peer.setRenewal(mode)
    const statuses: unknown[] = []
    peer.client.subscribeAudioStatus((status) => {
      statuses.push(status)
    })
    try {
      await peer.client.startAudioCapture("scripted-token")
      const terminal =
        mode === "failed"
          ? new Promise<MusicSessionClientError>((resolve) =>
              peer.client.subscribeTerminal(resolve),
            )
          : undefined
      peer.leaseTimers.at(-1)?.callback()
      if (terminal) expect((await terminal).message).toContain("renewal failed")
      else {
        await peer.client.play()
        expect(statuses).toContainEqual({
          type: "stopped",
          generation: 1,
          reason: "lease-expired",
        })
        expect(await peer.client.play()).toEqual({ action: "play" })
      }
      const before = peer.leaseTimers.length
      peer.leaseTimers.at(-1)?.callback()
      expect(peer.leaseTimers).toHaveLength(before)
      expect(
        peer.requests.filter((request) => request.type === "audio-start"),
      ).toHaveLength(1)
    } finally {
      await peer.close()
    }
  })
}

test("new clients refuse unleased capture on an older audio daemon without breaking playback", async () => {
  const peer = await scriptedAudioPeer()
  try {
    expect(await peer.client.listAudioSources()).toMatchObject({
      availability: "unavailable",
      reason: "not-negotiated",
    })
    expect(await peer.client.startAudioCapture("old-selection")).toEqual({
      type: "unavailable",
      reason: "capture-adapter-unavailable",
    })
    expect(
      peer.requests.some((request) => request.type === "audio-start"),
    ).toBe(false)
    expect(await peer.client.play()).toEqual({ action: "play" })
  } finally {
    await peer.close()
  }
})

test("delayed older statuses cannot cancel a fresh generation's renewal or restore its stale source", async () => {
  const peer = await scriptedAudioPeer(false, true)
  const statuses: unknown[] = []
  const remove = peer.client.subscribeAudioStatus((status) => {
    statuses.push(status)
  })
  try {
    await peer.client.startAudioCapture("first")
    await peer.client.stopAudioCapture()
    peer.setGeneration(2)
    await peer.client.startAudioCapture("second")
    await peer.send({
      ...activeAudio,
      status: { ...activeAudio.status, generation: 2 },
    })
    const before = statuses.length
    const timer = peer.leaseTimers.at(-1)
    await peer.send(
      {
        type: "audio-status",
        status: { type: "stopped", generation: 1, reason: "stop" },
      },
      {
        type: "audio-status",
        status: { type: "failed", generation: 1, reason: "setup" },
      },
      { type: "audio-status", status: { type: "acquiring", generation: 1 } },
      activeAudio,
    )
    expect(statuses).toHaveLength(before)
    expect(timer?.canceled).toBe(false)
    timer?.callback()
    await peer.client.play()
    expect(
      peer.requests.filter((request) => request.type === "audio-renew").at(-1)
        ?.generation,
    ).toBe(2)
  } finally {
    remove()
    await peer.close()
  }
})

for (const response of ["start", "stop"] as const) {
  test(`a delayed generation-1 ${response} response cannot regress generation 2 or disable its feature stream`, async () => {
    const peer = await scriptedAudioPeer(false, true)
    const updates: AudioFeatureUpdate[] = []
    const remove = peer.client.subscribeAudioFeatures((update) => {
      updates.push(update)
    })
    let pending: Promise<unknown> | undefined
    try {
      await peer.client.play()
      if (response === "start") {
        peer.holdStart(true)
        pending = peer.client.startAudioCapture("first")
      } else {
        await peer.client.startAudioCapture("first")
        peer.holdStop(true)
        pending = peer.client.stopAudioCapture()
      }
      await peer.client.play()
      const old = peer.requests.find(
        (request) => request.type === `audio-${response}`,
      )
      if (!old) throw new Error("missing held response")
      peer.holdStart(false)
      peer.holdStop(false)
      peer.setGeneration(2)
      await peer.client.startAudioCapture("second")
      await peer.send({
        ...activeAudio,
        status: { ...activeAudio.status, generation: 2 },
      })
      await peer.send({
        type: "response",
        requestId: old.requestId,
        ok: true,
        data:
          response === "start"
            ? { type: "started", generation: 1, source: source().identity }
            : { type: "stopped", generation: 1, reason: "stop" },
      })
      await pending
      await peer.send(
        {
          type: "audio-status",
          status: { type: "stopped", generation: 1, reason: "stop" },
        },
        { type: "audio-features", frame: { ...clientFrame(1), generation: 2 } },
      )
      expect(updates.at(-1)).toMatchObject({
        generation: 2,
        sequence: 1,
        spectrum: [0],
      })
      peer.leaseTimers.at(-1)?.callback()
      await peer.client.play()
      expect(
        peer.requests.filter((request) => request.type === "audio-renew").at(-1)
          ?.generation,
      ).toBe(2)
    } finally {
      const joined = Promise.allSettled(pending ? [pending] : [])
      remove()
      await peer.close()
      await joined
    }
  })
}

test("a newer acquisition retires an old local interest without granting the replacement generation", async () => {
  const peer = await scriptedAudioPeer(false, true)
  const statuses: unknown[] = []
  const remove = peer.client.subscribeAudioStatus((status) => {
    statuses.push(status)
  })
  try {
    await peer.client.startAudioCapture("first")
    const timer = peer.leaseTimers.at(-1)
    await peer.send({
      type: "audio-status",
      status: { type: "acquiring", generation: 2 },
    })
    expect(statuses).toContainEqual({
      type: "stopped",
      generation: 1,
      reason: "source-loss",
    })
    expect(timer?.canceled).toBe(true)
    timer?.callback()
    await peer.client.play()
    expect(
      peer.requests.filter((request) => request.type === "audio-renew"),
    ).toHaveLength(0)
    expect(
      peer.requests.filter((request) => request.type === "audio-start"),
    ).toHaveLength(1)
  } finally {
    remove()
    await peer.close()
  }
})

test("an expired audio lifetime requires a fresh connection but keeps metadata and playback usable", async () => {
  const peer = await scriptedAudioPeer(false, true)
  peer.setRenewal("rejected")
  try {
    await peer.client.startAudioCapture("first")
    peer.leaseTimers.at(-1)?.callback()
    await peer.client.play()
    await expect(
      peer.client.startAudioCapture("fresh-selection"),
    ).rejects.toThrow("fresh connection")
    expect(
      peer.requests.filter((request) => request.type === "audio-start"),
    ).toHaveLength(1)
    expect(await peer.client.play()).toEqual({ action: "play" })
  } finally {
    await peer.close()
  }
})

test("replayed global expiry cannot retire a fresh connection that never joined that generation", async () => {
  const peer = await scriptedAudioPeer(false, true)
  try {
    await peer.send({
      type: "audio-status",
      status: { type: "stopped", generation: 1, reason: "lease-expired" },
    })
    peer.setGeneration(2)
    expect(
      await peer.client.startAudioCapture("fresh-selection"),
    ).toMatchObject({ type: "started", generation: 2 })
    peer.leaseTimers.at(-1)?.callback()
    await peer.client.play()
    expect(
      peer.requests.filter((request) => request.type === "audio-renew").at(-1)
        ?.generation,
    ).toBe(2)
  } finally {
    await peer.close()
  }
})

test("Stop cannot erase joined-generation evidence before a delayed expiry retires the audio lifetime", async () => {
  const peer = await scriptedAudioPeer(false, true)
  try {
    await peer.client.startAudioCapture("first")
    peer.setStopRejected(true)
    expect(await peer.client.stopAudioCapture()).toEqual({
      type: "rejected",
      reason: "not-joined",
    })
    await peer.send({
      type: "audio-status",
      status: { type: "stopped", generation: 1, reason: "lease-expired" },
    })
    peer.setGeneration(2)
    await expect(peer.client.startAudioCapture("second")).rejects.toThrow(
      "fresh connection",
    )
    expect(await peer.client.play()).toEqual({ action: "play" })
    expect(
      peer.requests.filter((request) => request.type === "audio-start"),
    ).toHaveLength(1)
  } finally {
    await peer.close()
  }
})

for (const order of ["admission-first", "expiry-first"] as const) {
  test(`batched ${order} packets retire the joined lifetime before the Start promise handler runs`, async () => {
    const peer = await scriptedAudioPeer(false, true)
    peer.holdStart(true)
    let starting: Promise<unknown> | undefined
    try {
      starting = peer.client.startAudioCapture("first")
      await peer.client.play()
      const request = peer.requests.find(
        (request) => request.type === "audio-start",
      )
      if (!request) throw new Error("missing held admission")
      const admission = {
        type: "response",
        requestId: request.requestId,
        ok: true,
        data: { type: "started", generation: 1, source: source().identity },
      }
      const expiry = {
        type: "audio-status",
        status: { type: "stopped", generation: 1, reason: "lease-expired" },
      }
      await peer.send(
        ...(order === "admission-first"
          ? [admission, expiry]
          : [expiry, admission]),
      )
      await starting
      peer.holdStart(false)
      peer.setGeneration(2)
      await expect(peer.client.startAudioCapture("second")).rejects.toThrow(
        "fresh connection",
      )
      expect(peer.leaseTimers.every((timer) => timer.canceled)).toBe(true)
      expect(await peer.client.play()).toEqual({ action: "play" })
    } finally {
      const joined = Promise.allSettled(starting ? [starting] : [])
      await peer.close()
      await joined
    }
  })
}

test("an unrelated expiry replay during pending admission cannot revoke a fresh later generation", async () => {
  const peer = await scriptedAudioPeer(false, true)
  peer.holdStart(true)
  let starting: Promise<unknown> | undefined
  try {
    starting = peer.client.startAudioCapture("second-generation")
    await peer.client.play()
    const request = peer.requests.find(
      (request) => request.type === "audio-start",
    )
    if (!request) throw new Error("missing held admission")
    await peer.send(
      {
        type: "audio-status",
        status: { type: "stopped", generation: 1, reason: "lease-expired" },
      },
      {
        type: "response",
        requestId: request.requestId,
        ok: true,
        data: { type: "started", generation: 2, source: source().identity },
      },
    )
    expect(await starting).toMatchObject({ type: "started", generation: 2 })
    peer.leaseTimers.at(-1)?.callback()
    await peer.client.play()
    expect(
      peer.requests.filter((request) => request.type === "audio-renew").at(-1)
        ?.generation,
    ).toBe(2)
  } finally {
    const joined = Promise.allSettled(starting ? [starting] : [])
    await peer.close()
    await joined
  }
})

test("retired audio lifetime rejects buffered features even if a late active status arrives", async () => {
  const peer = await scriptedAudioPeer(false, true)
  const updates: AudioFeatureUpdate[] = []
  const remove = peer.client.subscribeAudioFeatures((update) => {
    updates.push(update)
  })
  try {
    await peer.client.startAudioCapture("first")
    await peer.send(
      {
        type: "audio-status",
        status: { type: "stopped", generation: 1, reason: "lease-expired" },
      },
      activeAudio,
      { type: "audio-features", frame: clientFrame(1) },
    )
    expect(updates.filter((update) => !("type" in update))).toHaveLength(0)
    expect(await peer.client.play()).toEqual({ action: "play" })
  } finally {
    remove()
    await peer.close()
  }
})

test("a newer unjoined global generation cannot hide expiry of this connection's joined lifetime", async () => {
  const peer = await scriptedAudioPeer(false, true)
  try {
    await peer.client.startAudioCapture("first")
    await peer.send({
      type: "audio-status",
      status: { type: "acquiring", generation: 2 },
    })
    await peer.send({
      type: "audio-status",
      status: { type: "stopped", generation: 1, reason: "lease-expired" },
    })
    let retained: unknown
    const remove = peer.client.subscribeAudioStatus((status) => {
      retained = status
    })
    remove()
    expect(retained).toEqual({ type: "acquiring", generation: 2 })
    peer.setGeneration(3)
    await expect(peer.client.startAudioCapture("third")).rejects.toThrow(
      "fresh connection",
    )
    expect(await peer.client.play()).toEqual({ action: "play" })
  } finally {
    await peer.close()
  }
})

test("newer unjoined presentation cannot suppress preserved expiry when the cached old admission arrives", async () => {
  const peer = await scriptedAudioPeer(false, true)
  peer.holdStart(true)
  let starting: Promise<unknown> | undefined
  try {
    starting = peer.client.startAudioCapture("first")
    await peer.client.play()
    const request = peer.requests.find(
      (request) => request.type === "audio-start",
    )
    if (!request) throw new Error("missing held admission")
    await peer.send(
      {
        type: "audio-status",
        status: { type: "stopped", generation: 1, reason: "lease-expired" },
      },
      { type: "audio-status", status: { type: "acquiring", generation: 2 } },
      {
        type: "response",
        requestId: request.requestId,
        ok: true,
        data: { type: "started", generation: 1, source: source().identity },
      },
    )
    await starting
    peer.holdStart(false)
    peer.setGeneration(3)
    await expect(peer.client.startAudioCapture("third")).rejects.toThrow(
      "fresh connection",
    )
    expect(peer.leaseTimers.every((timer) => timer.canceled)).toBe(true)
  } finally {
    const joined = Promise.allSettled(starting ? [starting] : [])
    await peer.close()
    await joined
  }
})

test("old joined-generation expiry cannot retire a newer admitted generation's healthy lease", async () => {
  const peer = await scriptedAudioPeer(false, true)
  try {
    await peer.client.startAudioCapture("first")
    await peer.client.stopAudioCapture()
    peer.setGeneration(2)
    await peer.client.startAudioCapture("second")
    const timer = peer.leaseTimers.at(-1)
    await peer.send({
      type: "audio-status",
      status: { type: "stopped", generation: 1, reason: "lease-expired" },
    })
    expect(timer?.canceled).toBe(false)
    timer?.callback()
    await peer.client.play()
    expect(
      peer.requests.filter((request) => request.type === "audio-renew").at(-1)
        ?.generation,
    ).toBe(2)
    expect(await peer.client.startAudioCapture("still-second")).toMatchObject({
      type: "started",
      generation: 2,
    })
  } finally {
    await peer.close()
  }
})
const activeAudio = {
  type: "audio-status",
  status: {
    type: "active",
    generation: 1,
    source: source().identity,
    capabilities: source().capabilities,
  },
}

test("client fences canonical source, capabilities, sequence, and timestamp without harming playback", async () => {
  const peer = await scriptedAudioPeer()
  const updates: AudioFeatureUpdate[] = []
  peer.client.subscribeAudioFeatures((update) => updates.push(update))
  try {
    await peer.send(activeAudio, {
      type: "audio-features",
      frame: clientFrame(1),
    })
    updates.length = 0
    for (const frame of [
      {
        ...clientFrame(2),
        source: { ...source().identity, launchIdentity: "reused-pid" },
      },
      {
        ...clientFrame(2),
        source: { ...source().identity, executableIdentity: "other-bin" },
      },
      {
        ...clientFrame(2),
        source: { ...source().identity, coreAudioObject: "other-tap" },
      },
      {
        ...clientFrame(2),
        capabilities: {
          spectrum: "absent",
          envelope: "absent",
          channels: "absent",
        },
        spectrum: [],
      },
      clientFrame(1),
      clientFrame(2, 999_999),
      { ...clientFrame(2), generation: 2 },
      { ...clientFrame(2), daemonInstanceId: "other" },
    ])
      await peer.send({ type: "audio-features", frame })
    expect(updates).toEqual([])
    await peer.send(
      { type: "audio-features", frame: clientFrame(3) },
      { type: "audio-features", frame: clientFrame(2) },
    )
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ sequence: 3, spectrum: [0] })
    expect(await peer.client.play()).toEqual({ action: "play" })
  } finally {
    await peer.close()
  }
})

test("replacement, Stop, and disconnection cancel the exact feature expiry callback", async () => {
  const peer = await scriptedAudioPeer(true)
  const updates: AudioFeatureUpdate[] = []
  peer.client.subscribeAudioFeatures((update) => updates.push(update))
  try {
    await peer.send(activeAudio, {
      type: "audio-features",
      frame: clientFrame(1),
    })
    expect(peer.timers.map((timer) => timer.canceled)).toEqual([false])
    expect(peer.timers[0]?.delayMs).toBe(500)
    await peer.send({ type: "audio-features", frame: clientFrame(2) })
    expect(peer.timers.map((timer) => timer.canceled)).toEqual([true, false])
    await peer.send({
      type: "audio-status",
      status: { type: "stopped", generation: 1, reason: "stop" },
    })
    expect(peer.timers.map((timer) => timer.canceled)).toEqual([true, true])
    updates.length = 0
    for (const timer of peer.timers) if (!timer.canceled) timer.callback()
    expect(updates).toEqual([])
    await peer.send(activeAudio, {
      type: "audio-features",
      frame: clientFrame(3),
    })
    expect(peer.timers.map((timer) => timer.canceled)).toEqual([
      true,
      true,
      false,
    ])
    let terminal: (() => void) | undefined
    const disconnected = new Promise<void>((resolve) => {
      terminal = resolve
    })
    peer.client.subscribeTerminal(() => terminal?.())
    peer.disconnect()
    await disconnected
    expect(peer.timers.map((timer) => timer.canceled)).toEqual([
      true,
      true,
      true,
    ])
  } finally {
    await peer.close()
  }
})

test("expiry clears features but preserves sequence and timestamp watermarks", async () => {
  const peer = await scriptedAudioPeer()
  const updates: AudioFeatureUpdate[] = []
  let cleared: (() => void) | undefined
  const expired = new Promise<void>((resolve) => {
    cleared = resolve
  })
  peer.client.subscribeAudioFeatures((update) => {
    updates.push(update)
    if ("type" in update && update.reason === "stale") cleared?.()
  })
  try {
    await peer.send(activeAudio, {
      type: "audio-features",
      frame: { ...clientFrame(5), sampleAgeMs: 499 },
    })
    await expired
    expect(updates.at(-1)).toMatchObject({
      type: "clear",
      reason: "stale",
      sequence: 5,
    })
    updates.length = 0
    await peer.send(
      { type: "audio-features", frame: clientFrame(5) },
      { type: "audio-features", frame: clientFrame(4) },
      { type: "audio-features", frame: clientFrame(6, 999_999) },
    )
    expect(updates).toEqual([])
    await peer.send({ type: "audio-features", frame: clientFrame(6) })
    expect(updates).toHaveLength(1)
  } finally {
    await peer.close()
  }
})

for (const reason of ["stop", "source-loss"] as const) {
  test(`a features-only listener clears immediately on ${reason} while metadata and Play remain usable`, async () => {
    const peer = await scriptedAudioPeer()
    const updates: AudioFeatureUpdate[] = []
    peer.client.subscribeAudioFeatures((update) => updates.push(update))
    try {
      await peer.send(
        activeAudio,
        { type: "audio-features", frame: clientFrame(1) },
        {
          type: "state",
          snapshot: {
            daemonInstanceId: "scripted",
            revision: 1,
            state: emptyPlayer(),
          },
        },
      )
      updates.length = 0
      await peer.send({
        type: "audio-status",
        status: { type: "stopped", generation: 1, reason },
      })
      expect(updates).toEqual([
        {
          type: "clear",
          reason: reason === "stop" ? "stopped" : "source-loss",
          generation: 1,
          sequence: 1,
        },
      ])
      expect(peer.client.state?.revision).toBe(1)
      expect(peer.client.status?.kind).toBe("ready")
      expect(await peer.client.play()).toEqual({ action: "play" })
      await peer.send({ type: "audio-features", frame: clientFrame(2) })
      expect(updates).toHaveLength(1)
    } finally {
      await peer.close()
    }
  })
}

test("disconnection sends a truthful clear before discarding features-only listeners", async () => {
  const peer = await scriptedAudioPeer()
  const updates: AudioFeatureUpdate[] = []
  let clear: (() => void) | undefined
  const disconnected = new Promise<void>((resolve) => {
    clear = resolve
  })
  peer.client.subscribeAudioFeatures((update) => {
    updates.push(update)
    if ("type" in update && update.reason === "disconnected") clear?.()
  })
  try {
    await peer.send(activeAudio, {
      type: "audio-features",
      frame: clientFrame(1),
    })
    updates.length = 0
    peer.disconnect()
    await disconnected
    expect(updates).toEqual([
      { type: "clear", reason: "disconnected", generation: 1, sequence: 1 },
    ])
  } finally {
    await peer.close()
  }
})
