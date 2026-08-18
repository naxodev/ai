import { expect, test as baseTest } from "bun:test"
import { createSessionTest, type SessionTestFn } from "./unix-session.ts"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import net from "node:net"
import { EventEmitter } from "node:events"
import { NdjsonFramer } from "../session/framing.ts"
import {
  MusicSessionClientError,
  connectOrStartMusicSession,
  createReconnectingMusicSessionClientEffect,
  connectOrStartMusicSessionEffect,
  createMusicSessionClient,
  createReconnectingMusicSessionClient,
  launchManagedMusicSessionDaemon,
  resolveMusicSessionDaemonRuntime,
  discoverMusicSession,
  type MusicSessionClient,
  type ReconnectingMusicSessionClient,
} from "../session/client.ts"
import {
  acquireStartupMarkerLease,
  MusicSessionRuntimeError,
  prepareManagedRuntimeDirectory,
  resolveMusicSessionRuntimePaths,
  resolveMusicSessionStartup,
  resolveConfig,
  defaults,
  layerFromConfig,
  MusicSessionConfig,
} from "../session/config.ts"
import {
  Clock,
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Latch,
  Random,
  Scope,
} from "effect"
import { TestClock } from "effect/testing"
import type {
  ArtworkResult,
  ProviderStatus,
  RevisionedState,
  TransportResult,
} from "../session/protocol.ts"
import {
  createFakeProvider,
  startMusicSessionServer,
} from "../session/server.ts"

const test: SessionTestFn = createSessionTest(
  baseTest,
  new Set([
    "TestClock startup retries are immediate, paced, bounded, and interruptible",
    "explicit terminal observation replays one retained retryable loss",
    "explicit artwork requests correlate independently and settle disposed work",
    "explicit artwork requests report connection loss rather than command indeterminacy",
    "reconnecting artwork is delegated once and never replayed after loss",
    "reconnecting artwork fences a late completion after managed disposal",
    "reconnecting disposal disposes a late Promise discovery client",
    "reconnecting disposal owns a client that loses the reservation-to-adoption race",
    "reconnecting disposal is one completion through a reentrant listener",
    "reconnecting disposal owns a healthy client while cleanup is interrupted",
    "reconnecting fences late A callbacks and replays retained listeners",
    "reconnecting replacement incompatibility retains its terminal range once",
    "reconnecting preserves runtime failures instead of disguising them",
    "reconnecting disposal interrupts a TestClock replacement sleep",
    "reconnecting uses the bounded Phase 3 schedule without a busy loop",
    "managed runtime resolver and preparation keep a compact owner-only layout",
    "managed runtime rejects wrong-mode and symlinked roots without repair",
    "managed discovery rejects unsafe socket artifacts without connecting or removing them",
    "managed runtime rejects non-directory and simulated foreign-owned roots without repair",
    "exclusive startup marker lease has one winner and preserves replacements",
    "connect-or-start acquires one marker, launches once, and returns a hello client",
    "reconnecting client adopts one replacement generation without replay",
    "reconnecting client adopts B only after A genuinely idles out",
    "reconnecting before A's idle grace keeps the same generation",
    "returned managed client does not relaunch after live server loss",
    "20 concurrent managed callers converge on one selected graph",
    "discovery keeps waiting when a live marker's socket appears mid-probe",
    "marker release failure disposes a successful client and remains observable",
    "owned daemon readiness closes the transient hello-reset window",
    "a managed child early exit reaches acquisition without becoming timeout",
    "a peer remains terminal occupied after the launched daemon is ready",
    "marker is released after startup timeout and interruption",
    "launcher rejection releases its owned marker",
    "primary startup failure remains primary when marker release fails",
    "workflow marker release does not remove a replacement marker",
    "incompatible managed startup is terminal after marker acquisition",
    "TestClock waiting startup stops at an incompatible healthy generation",
    "incompatible managed startup is terminal before marker acquisition",
    "managed marker EPERM process checks stay conservative through the seam",
    "invalid managed markers fail closed and remain untouched",
    "dead managed marker grants guarded idempotent cleanup",
    "unknown marker process errors remain starting without cleanup",
    "refused socket disappearance after the connection attempt is missing without cleanup authority",
    "refused managed socket yields guarded idempotent stale cleanup",
    "stale cleanup refuses a replacement artifact",
    "simulated foreign socket and marker ownership fail closed without cleanup",
    "malformed and reset managed peers stay occupied without cleanup",
    "a retryable reset with a live startup marker remains starting",
    "terminal reset and malformed peers do not borrow live-marker authority",
    "reset classification fails closed when endpoint or marker changes during inspection",
    "reset classification rejects an in-place marker generation rewrite",
    "managed discovery returns a handshaken healthy client",
    "managed discovery preserves a live incompatible daemon generation",
    "healthy discovery grants cleanup only for a separately proven dead marker",
    "healthy discovery wins over an untrusted startup marker",
    "a valid live startup marker is starting and grants no cleanup",
    "a live marker cannot mask unsafe socket type or ownership",
    "malformed negotiated hello result fails once and destroys the socket",
    "hello failure response and malformed frame destroy the client socket",
    "impossible negotiated capabilities destroy the client socket",
    "out-of-order transport responses settle only their matching command",
    "unsolicited and duplicate responses cannot settle later requests",
    "typed command failures are request-local and disposal is terminal",
    "state authority and listener isolation retain only ordered daemon snapshots",
    "connection loss races leave every admitted command indeterminate without replay",
    "malformed transport success terminates only after indeterminate settlement",
    "active malformed daemon data terminates once without publishing late frames",
    "disposal wins first and suppresses late daemon callbacks",
    "split and multiple status frames isolate listeners and retain command use",
    "hello chunk status survives the active-reader transition",
    "explicit client bounds pending requests and recovers after settlement",
    "explicit client exposes current negotiated revision and capabilities",
  ]),
)

test("startup timing resolves through the tagged config boundary", async () => {
  await expect(
    Effect.runPromise(
      resolveMusicSessionStartup({
        attempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 40,
      }),
    ),
  ).resolves.toEqual({ attempts: 3, initialDelayMs: 10, maxDelayMs: 40 })
  await expect(
    resolveConfig({
      socketPath: "/tmp/music-session-config.sock",
      idleGraceMs: 42,
    }),
  ).resolves.toMatchObject({ idleGraceMs: 42 })
  for (const idleGraceMs of [
    0,
    -1,
    1.5,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    await expect(
      resolveConfig({
        socketPath: "/tmp/music-session-config.sock",
        idleGraceMs,
      }),
    ).rejects.toMatchObject({
      _tag: "MusicSession.ConfigError",
      setting: "idleGraceMs",
    })
  const configuredIdleGrace = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return (yield* MusicSessionConfig).options.idleGraceMs
      }).pipe(
        Effect.provide(layerFromConfig),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              MUSIC_SESSION_SOCKET: "/tmp/music-session-config.sock",
              MUSIC_SESSION_IDLE_GRACE_MS: "43",
            }),
          ),
        ),
      ),
    ),
  )
  expect(configuredIdleGrace).toBe(43)
  await expect(
    resolveConfig({
      socketPath: "/tmp/music-session-config.sock",
      inboundChunkQueueCapacity: 7,
      maxFramesPerChunk: 8,
      mandatoryOutboundQueueCapacity: 9,
    }),
  ).resolves.toMatchObject({
    inboundChunkQueueCapacity: 7,
    maxFramesPerChunk: 8,
    mandatoryOutboundQueueCapacity: 9,
  })
  for (const setting of [
    "inboundChunkQueueCapacity",
    "maxFramesPerChunk",
    "mandatoryOutboundQueueCapacity",
  ] as const)
    for (const value of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      await expect(
        resolveConfig({
          socketPath: "/tmp/music-session-config.sock",
          [setting]: value,
        }),
      ).rejects.toMatchObject({
        _tag: "MusicSession.ConfigError",
        setting,
      })
  expect(defaults.idleGraceMs).toBeGreaterThan(0)
  for (const [settings, setting] of [
    [{ attempts: 0 }, "startup.attempts"],
    [{ initialDelayMs: Number.POSITIVE_INFINITY }, "startup.initialDelayMs"],
    [{ initialDelayMs: 41, maxDelayMs: 40 }, "startup.maxDelayMs"],
  ] as const) {
    await expect(
      Effect.runPromise(resolveMusicSessionStartup(settings)),
    ).rejects.toMatchObject({
      _tag: "MusicSession.ConfigError",
      setting,
    })
  }
})

test("TestClock startup retries are immediate, paced, bounded, and interruptible", async () => {
  const runtime = resolveMusicSessionRuntimePaths({
    root: "/tmp",
    uid: process.getuid?.() ?? -1,
  })
  const firstAttempt = Latch.makeUnsafe()
  let attempts = 0
  let launches = 0
  let releases = 0
  const attemptTimes: number[] = []
  const lease = {
    paths: runtime,
    attemptToken: "test-lease",
    release: async () => {
      releases++
    },
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make()
        const pending = connectOrStartMusicSessionEffect(
          {
            runtime,
            clientId: "test-clock-pending",
            hostKind: "test",
            startup: { attempts: 4, initialDelayMs: 10, maxDelayMs: 25 },
            launcher: async () => {
              launches++
            },
          },
          {
            discover: async () => ({ type: "missing" }),
            acquireLease: async () => ({ type: "acquired", lease }),
            onAttempt: () => {
              attempts++
              attemptTimes.push(clock.currentTimeMillisUnsafe())
              Latch.openUnsafe(firstAttempt)
            },
          },
        )
        const fiber = yield* pending.pipe(
          Effect.provideService(Clock.Clock, clock),
          Random.withSeed("startup-pacing"),
          Effect.forkScoped,
        )
        yield* Latch.await(firstAttempt)
        expect(attempts).toBe(1)
        yield* clock.adjust("7 millis")
        expect(attempts).toBe(1)
        yield* clock.adjust("1 hour")
        yield* Fiber.join(fiber).pipe(
          Effect.match({
            onFailure: (error) =>
              Effect.sync(() =>
                expect(error).toMatchObject({
                  _tag: "MusicSession.StartupError",
                  operation: "timeout",
                }),
              ),
            onSuccess: () => Effect.die("expected startup timeout"),
          }),
        )
        expect(attempts).toBe(4)
        expect(launches).toBe(1)
        expect(releases).toBe(1)
        const delays = attemptTimes
          .slice(1)
          .map((time, index) => time - attemptTimes[index]!)
        // Jitter is deterministic here and each exponential interval stays in
        // its 0.8-1.2 range; the final jittered delay is capped at 25 ms.
        expect(delays[0]).toBeGreaterThanOrEqual(8)
        expect(delays[0]).toBeLessThanOrEqual(12)
        expect(delays[1]).toBeGreaterThanOrEqual(16)
        expect(delays[1]).toBeLessThanOrEqual(24)
        expect(delays[2]).toBe(25)

        const successReady = Latch.makeUnsafe()
        const client = { dispose: () => {} } as Awaited<
          ReturnType<typeof connectOrStartMusicSession>
        >
        let successAttempts = 0
        const success = connectOrStartMusicSessionEffect(
          {
            runtime,
            clientId: "test-clock-success",
            hostKind: "test",
            startup: { attempts: 4, initialDelayMs: 10, maxDelayMs: 25 },
          },
          {
            discover: async () => {
              successAttempts++
              Latch.openUnsafe(successReady)
              return successAttempts === 1
                ? { type: "starting" }
                : { type: "healthy", client }
            },
          },
        )
        const successful = yield* success.pipe(
          Effect.provideService(Clock.Clock, clock),
          Random.withSeed("startup-success"),
          Effect.forkScoped,
        )
        yield* Latch.await(successReady)
        yield* clock.adjust("20 millis")
        expect(yield* Fiber.join(successful)).toBe(client)
        expect(successAttempts).toBe(2)
        yield* clock.adjust("1 hour")
        expect(successAttempts).toBe(2)

        const sleeping = Latch.makeUnsafe()
        let interruptedAttempts = 0
        const interrupted = yield* connectOrStartMusicSessionEffect(
          {
            runtime,
            clientId: "test-clock-interrupt",
            hostKind: "test",
            startup: { attempts: 4, initialDelayMs: 10, maxDelayMs: 25 },
          },
          {
            discover: async () => {
              interruptedAttempts++
              Latch.openUnsafe(sleeping)
              return { type: "starting" }
            },
          },
        ).pipe(
          Effect.provideService(Clock.Clock, clock),
          Random.withSeed("startup-interrupt"),
          Effect.forkScoped,
        )
        yield* Latch.await(sleeping)
        // Advancing less than the earliest jittered delay lets the workflow
        // install and remain in its production schedule sleep.
        yield* clock.adjust("1 millis")
        expect(interruptedAttempts).toBe(1)
        yield* Fiber.interrupt(interrupted)
        yield* clock.adjust("1 hour")
        expect(interruptedAttempts).toBe(1)
      }),
    ),
  )
})

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

async function startScriptedDaemon(
  helloTail = "",
  capabilities = ["state-replay", "transport"],
): Promise<ScriptedDaemon> {
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
            `${JSON.stringify({ type: "response", requestId: 0, ok: true, data: { daemonInstanceId: "daemon", packageVersion: "test", protocol: { major: 1, minRevision: 0, maxRevision: 1, selectedRevision: 1 }, capabilities } })}\n${helloTail}`,
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

const scriptedGeneration = (daemonInstanceId: string) => {
  const statusListeners = new Set<(status: ProviderStatus) => void>()
  const stateListeners = new Set<(state: RevisionedState) => void>()
  const terminalListeners = new Set<(error: MusicSessionClientError) => void>()
  let disposed = false
  let status: ProviderStatus | undefined
  let state: RevisionedState | undefined
  const playResolvers: {
    resolve: (result: TransportResult) => void
    reject: (error: MusicSessionClientError) => void
  }[] = []
  const artworkResolvers: {
    resolve: (result: ArtworkResult) => void
    reject: (error: MusicSessionClientError) => void
  }[] = []
  const queuedCallbacks: (() => void)[] = []
  const notify = <A>(listeners: Set<(value: A) => void>, value: A) => {
    for (const listener of [...listeners]) listener(value)
  }
  const queue = <A>(listeners: Set<(value: A) => void>, value: A) => {
    queuedCallbacks.push(
      ...[...listeners].map((listener) => () => listener(value)),
    )
  }
  const client: MusicSessionClient = {
    daemonInstanceId,
    negotiatedCapabilities: [],
    selectedRevision: 1,
    get status() {
      return status
    },
    get state() {
      return state
    },
    subscribeStatus: (listener) => {
      statusListeners.add(listener)
      if (status) listener(status)
      return () => statusListeners.delete(listener)
    },
    subscribeState: (listener) => {
      stateListeners.add(listener)
      if (state) listener(state)
      return () => stateListeners.delete(listener)
    },
    subscribeTerminal: (listener) => {
      terminalListeners.add(listener)
      return () => terminalListeners.delete(listener)
    },
    toggle: async () => ({ action: "toggle" }),
    play: () =>
      new Promise<TransportResult>((resolve, reject) =>
        playResolvers.push({ resolve, reject }),
      ),
    pause: async () => ({ action: "pause" }),
    next: async () => ({ action: "next" }),
    previous: async () => ({ action: "previous" }),
    seek: async () => ({ action: "seek" }),
    artwork: () =>
      new Promise<ArtworkResult>((resolve, reject) =>
        artworkResolvers.push({ resolve, reject }),
      ),
    dispose: () => {
      disposed = true
      statusListeners.clear()
      stateListeners.clear()
      terminalListeners.clear()
    },
  }
  return {
    client,
    status: (next: ProviderStatus) => {
      status = next
      notify(statusListeners, next)
    },
    queueStatus: (next: ProviderStatus) => {
      status = next
      queue(statusListeners, next)
    },
    state: (next: RevisionedState) => {
      state = next
      notify(stateListeners, next)
    },
    queueState: (next: RevisionedState) => {
      state = next
      queue(stateListeners, next)
    },
    terminal: (error: MusicSessionClientError, preserveArtwork = false) => {
      notify(terminalListeners, error)
      for (const pending of playResolvers.splice(0))
        pending.reject(
          new MusicSessionClientError({
            code: "INDETERMINATE_COMMAND",
            message: "generation lost before command response",
            retryable: false,
          }),
        )
      if (!preserveArtwork)
        for (const pending of artworkResolvers.splice(0))
          pending.reject(
            new MusicSessionClientError({
              code: "CONNECTION_LOST",
              message: "generation lost before artwork response",
              retryable: true,
            }),
          )
    },
    queueTerminal: (error: MusicSessionClientError) => {
      queue(terminalListeners, error)
    },
    flushQueued: () => {
      for (const callback of queuedCallbacks.splice(0)) callback()
    },
    respondPlay: () => playResolvers.shift()?.resolve({ action: "play" }),
    respondArtwork: (result: ArtworkResult = { type: "unavailable" }) =>
      artworkResolvers.shift()?.resolve(result),
    get artworkCalls() {
      return artworkResolvers.length
    },
    get disposed() {
      return disposed
    },
  }
}

test("explicit terminal observation replays one retained retryable loss", async () => {
  const daemon = await startScriptedDaemon()
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "terminal-observer",
      hostKind: "test",
    })
    const observed: MusicSessionClientError[] = []
    const terminal = new Promise<void>((resolve) => {
      client!.subscribeTerminal((error) => {
        observed.push(error)
        resolve()
      })
    })
    daemon.destroy()
    await terminal
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({
      code: "CONNECTION_LOST",
      retryable: true,
    })
    client.subscribeTerminal((error) => observed.push(error))
    client.dispose()
    expect(observed).toHaveLength(2)
    expect(observed[1]).toBe(observed[0])
  } finally {
    client?.dispose()
    await daemon.close()
  }
})

test("explicit artwork requests correlate independently and settle disposed work", async () => {
  const daemon = await startScriptedDaemon("", [
    "state-replay",
    "transport",
    "native-artwork",
  ])
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  const identity = {
    id: "id",
    name: "Song",
    artists: "Artist",
    album: "Album",
    duration_ms: 1,
  }
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "artwork-correlation",
      hostKind: "test",
    })
    const first = client.artwork(identity)
    const second = client.artwork({ ...identity, id: "other" })
    const frames = await daemon.received(3)
    const requests = frames.slice(1)
    expect(requests.map((frame) => frame.type)).toEqual(["artwork", "artwork"])
    daemon.send({
      type: "response",
      requestId: requests[1]!.requestId,
      ok: true,
      data: { type: "unavailable" },
    })
    daemon.send({
      type: "response",
      requestId: requests[0]!.requestId,
      ok: true,
      data: { type: "available", base64: "AQ==" },
    })
    await expect(first).resolves.toEqual({ type: "available", base64: "AQ==" })
    await expect(second).resolves.toEqual({ type: "unavailable" })

    const disposed = client.artwork(identity)
    await daemon.received(4)
    client.dispose()
    await expect(disposed).rejects.toMatchObject({ code: "DISPOSED" })
  } finally {
    client?.dispose()
    await daemon.close()
  }
})

test("explicit artwork requests report connection loss rather than command indeterminacy", async () => {
  const daemon = await startScriptedDaemon("", [
    "state-replay",
    "transport",
    "native-artwork",
  ])
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "artwork-loss",
      hostKind: "test",
    })
    const pending = client.artwork({
      id: "id",
      name: "Song",
      artists: "Artist",
      album: "Album",
      duration_ms: 1,
    })
    await daemon.received(2)
    daemon.destroy()
    await expect(pending).rejects.toMatchObject({ code: "CONNECTION_LOST" })
  } finally {
    client?.dispose()
    await daemon.close()
  }
})

test("reconnecting artwork is delegated once and never replayed after loss", async () => {
  const scope = await Effect.runPromise(Scope.make())
  const first = scriptedGeneration("generation-a")
  const second = scriptedGeneration("generation-b")
  let connects = 0
  try {
    const managed = await Effect.runPromise(
      createReconnectingMusicSessionClientEffect(
        { clientId: "artwork-generation", hostKind: "test" },
        {
          connect: () =>
            Effect.succeed(++connects === 1 ? first.client : second.client),
        },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const pending = managed.artwork({
      id: "id",
      name: "Song",
      artists: "Artist",
      album: "Album",
      duration_ms: 1,
    })
    expect(first.artworkCalls).toBe(1)
    first.terminal(
      new MusicSessionClientError({
        code: "CONNECTION_LOST",
        message: "generation A disappeared",
        retryable: true,
      }),
      true,
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(connects).toBe(2)
    expect(second.artworkCalls).toBe(0)
    first.respondArtwork({ type: "available", base64: "AQ==" })
    await expect(pending).rejects.toMatchObject({ code: "CONNECTION_LOST" })
    expect(second.artworkCalls).toBe(0)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

test("reconnecting artwork fences a late completion after managed disposal", async () => {
  const scope = await Effect.runPromise(Scope.make())
  const generation = scriptedGeneration("generation-a")
  try {
    const managed = await Effect.runPromise(
      createReconnectingMusicSessionClientEffect(
        { clientId: "artwork-disposal", hostKind: "test" },
        { connect: () => Effect.succeed(generation.client) },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const pending = managed.artwork({
      id: "id",
      name: "Song",
      artists: "Artist",
      album: "Album",
      duration_ms: 1,
    })
    expect(generation.artworkCalls).toBe(1)
    await managed.dispose()
    generation.respondArtwork({ type: "available", base64: "AQ==" })
    await expect(pending).rejects.toMatchObject({ code: "DISPOSED" })
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

test("reconnecting disposal disposes a late Promise discovery client", async () => {
  const scope = await Effect.runPromise(Scope.make())
  const first = scriptedGeneration("generation-a")
  const late = scriptedGeneration("generation-b")
  let connects = 0
  let resolveDiscovery: (() => void) | undefined
  let markDiscoveryStarted: (() => void) | undefined
  const discoveryStarted = new Promise<void>((resolve) => {
    markDiscoveryStarted = resolve
  })
  try {
    const managed = await Effect.runPromise(
      createReconnectingMusicSessionClientEffect(
        { clientId: "late-discovery", hostKind: "test" },
        {
          connect: (options) => {
            connects++
            if (connects === 1) return Effect.succeed(first.client)
            return connectOrStartMusicSessionEffect(options, {
              discover: () =>
                new Promise((resolve) => {
                  resolveDiscovery = () =>
                    resolve({ type: "healthy", client: late.client })
                  markDiscoveryStarted?.()
                }),
            })
          },
        },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    first.terminal(
      new MusicSessionClientError({
        code: "CONNECTION_LOST",
        message: "generation A disappeared",
        retryable: true,
      }),
    )
    await discoveryStarted
    await managed.dispose()
    resolveDiscovery?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(connects).toBe(2)
    expect(late.disposed).toBe(true)
    expect(managed.connection.type).toBe("disposed")
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

test("reconnecting disposal owns a client that loses the reservation-to-adoption race", async () => {
  const scope = await Effect.runPromise(Scope.make())
  const first = scriptedGeneration("generation-a")
  const late = scriptedGeneration("generation-b")
  let connects = 0
  let managed: ReconnectingMusicSessionClient | undefined
  let resolveDisposed: (() => void) | undefined
  const disposed = new Promise<void>((resolve) => {
    resolveDisposed = resolve
  })
  try {
    managed = await Effect.runPromise(
      createReconnectingMusicSessionClientEffect(
        { clientId: "reservation-race", hostKind: "test" },
        {
          connect: () => {
            connects++
            return connects === 1
              ? Effect.succeed(first.client)
              : Effect.succeed(late.client)
          },
          onReserved: () => {
            if (connects === 2)
              void managed?.dispose().then(() => resolveDisposed?.())
          },
        },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    first.terminal(
      new MusicSessionClientError({
        code: "CONNECTION_LOST",
        message: "generation A disappeared",
        retryable: true,
      }),
    )
    await disposed
    expect(connects).toBe(2)
    expect(late.disposed).toBe(true)
    expect(managed.connection.type).toBe("disposed")
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

test("reconnecting disposal is one completion through a reentrant listener", async () => {
  const scope = await Effect.runPromise(Scope.make())
  const first = scriptedGeneration("generation-a")
  try {
    const managed = await Effect.runPromise(
      createReconnectingMusicSessionClientEffect(
        { clientId: "dispose-once", hostKind: "test" },
        { connect: () => Effect.succeed(first.client) },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    let outer: Promise<void> | undefined
    let reentrant: Promise<void> | undefined
    managed.subscribeConnection((state) => {
      if (state.type === "disposed") reentrant = managed.dispose()
    })
    outer = managed.dispose()
    const concurrent = managed.dispose()
    expect(concurrent).toBe(outer)
    await outer
    expect(reentrant).toBe(outer)
    expect(first.disposed).toBe(true)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

test("reconnecting disposal owns a healthy client while cleanup is interrupted", async () => {
  const scope = await Effect.runPromise(Scope.make())
  const first = scriptedGeneration("generation-a")
  const late = scriptedGeneration("generation-b")
  let connects = 0
  let resolveCleanup: (() => void) | undefined
  let markCleanupStarted: (() => void) | undefined
  const cleanupStarted = new Promise<void>((resolve) => {
    markCleanupStarted = resolve
  })
  try {
    const managed = await Effect.runPromise(
      createReconnectingMusicSessionClientEffect(
        { clientId: "late-cleanup", hostKind: "test" },
        {
          connect: (options) => {
            connects++
            if (connects === 1) return Effect.succeed(first.client)
            return connectOrStartMusicSessionEffect(options, {
              discover: async () => ({
                type: "healthy",
                client: late.client,
                cleanup: () =>
                  new Promise<void>((resolve) => {
                    resolveCleanup = resolve
                    markCleanupStarted?.()
                  }),
              }),
            })
          },
        },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    first.terminal(
      new MusicSessionClientError({
        code: "CONNECTION_LOST",
        message: "generation A disappeared",
        retryable: true,
      }),
    )
    await cleanupStarted
    await managed.dispose()
    resolveCleanup?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(connects).toBe(2)
    expect(late.disposed).toBe(true)
    expect(managed.connection.type).toBe("disposed")
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

test("reconnecting fences late A callbacks and replays retained listeners", async () => {
  const scope = await Effect.runPromise(Scope.make())
  const first = scriptedGeneration("generation-a")
  const second = scriptedGeneration("generation-b")
  const player = createFakeProvider().state
  const aStatus: ProviderStatus = {
    kind: "ready",
    provider: null,
    message: "generation A",
  }
  const bStatus: ProviderStatus = {
    kind: "ready",
    provider: null,
    message: "generation B",
  }
  const aState: RevisionedState = {
    daemonInstanceId: "generation-a",
    revision: 9,
    state: player,
  }
  const bState: RevisionedState = {
    daemonInstanceId: "generation-b",
    revision: 1,
    state: player,
  }
  first.status(aStatus)
  first.state(aState)
  second.status(bStatus)
  second.state(bState)
  const replacement = Deferred.makeUnsafe<MusicSessionClient>()
  let connects = 0
  try {
    const managed = await Effect.runPromise(
      createReconnectingMusicSessionClientEffect(
        { clientId: "generation-fence", hostKind: "test" },
        {
          connect: () => {
            connects++
            return connects === 1
              ? Effect.succeed(first.client)
              : Deferred.await(replacement)
          },
        },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const statuses: string[] = []
    const states: string[] = []
    const lifecycle: string[] = []
    managed.subscribeStatus((status) => statuses.push(status.message))
    managed.subscribeState((state) => states.push(state.daemonInstanceId))
    managed.subscribeConnection((state) => lifecycle.push(state.type))
    const oldPlay = managed.play()
    first.queueStatus({ ...aStatus, message: "late A status" })
    first.queueState({ ...aState, revision: 10 })
    first.queueTerminal(
      new MusicSessionClientError({
        code: "CONNECTION_LOST",
        message: "late A terminal",
        retryable: true,
      }),
    )
    first.terminal(
      new MusicSessionClientError({
        code: "CONNECTION_LOST",
        message: "generation A disappeared",
        retryable: true,
      }),
    )
    const retainedStatuses: string[] = []
    const retainedStates: string[] = []
    const unsubscribeStatus = managed.subscribeStatus((status) =>
      retainedStatuses.push(status.message),
    )
    const unsubscribeState = managed.subscribeState((state) =>
      retainedStates.push(state.daemonInstanceId),
    )
    expect(retainedStatuses).toEqual(["generation A"])
    expect(retainedStates).toEqual(["generation-a"])
    unsubscribeStatus()
    unsubscribeStatus()
    unsubscribeState()
    unsubscribeState()
    Deferred.doneUnsafe(replacement, Effect.succeed(second.client))
    await new Promise<void>((resolve) => {
      managed.subscribeConnection((state) => {
        if (
          state.type === "connected" &&
          state.daemonInstanceId === "generation-b"
        )
          resolve()
      })
    })
    const replacementPlay = managed.play()
    let replacementSettled = false
    void replacementPlay.then(() => {
      replacementSettled = true
    })
    await expect(oldPlay).rejects.toMatchObject({
      code: "INDETERMINATE_COMMAND",
    })
    first.flushQueued()
    await Promise.resolve()
    expect(replacementSettled).toBe(false)
    second.respondPlay()
    await expect(replacementPlay).resolves.toEqual({ action: "play" })
    expect(managed.status).toEqual(bStatus)
    expect(managed.state).toEqual(bState)
    expect(statuses).toEqual(["generation A", "generation B"])
    expect(states).toEqual(["generation-a", "generation-b"])
    expect(retainedStatuses).toEqual(["generation A"])
    expect(retainedStates).toEqual(["generation-a"])
    expect(lifecycle).toEqual(["connected", "reconnecting", "connected"])
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

test("reconnecting replacement incompatibility retains its terminal range once", async () => {
  const scope = await Effect.runPromise(Scope.make())
  const first = scriptedGeneration("generation-a")
  const range = { major: 1, minRevision: 0, maxRevision: 1 }
  const incompatible = new MusicSessionClientError({
    code: "INCOMPATIBLE_PROTOCOL",
    message: "replacement is incompatible",
    retryable: false,
    details: { client: range, daemon: { ...range, minRevision: 9 } },
  })
  let attempts = 0
  try {
    const managed = await Effect.runPromise(
      createReconnectingMusicSessionClientEffect(
        { clientId: "replacement-incompatible", hostKind: "test" },
        {
          connect: () => {
            attempts++
            return attempts === 1
              ? Effect.succeed(first.client)
              : Effect.fail(incompatible)
          },
        },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const terminal = new Promise<void>((resolve) => {
      managed.subscribeConnection((state) => {
        if (state.type === "terminal") resolve()
      })
    })
    first.terminal(
      new MusicSessionClientError({
        code: "CONNECTION_LOST",
        message: "generation A disappeared",
        retryable: true,
      }),
    )
    await terminal
    expect(managed.connection).toEqual({
      type: "terminal",
      error: incompatible,
    })
    expect(attempts).toBe(2)
    const replayed: unknown[] = []
    managed.subscribeConnection((state) => replayed.push(state))
    expect(replayed).toEqual([{ type: "terminal", error: incompatible }])
    await Promise.resolve()
    expect(attempts).toBe(2)
    const afterTerminal: string[] = []
    managed.subscribeConnection((state) => afterTerminal.push(state.type))
    await managed.dispose()
    expect(managed.connection.type).toBe("disposed")
    expect(afterTerminal).toEqual(["terminal", "disposed"])
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

test("reconnecting preserves runtime failures instead of disguising them", async () => {
  const scope = await Effect.runPromise(Scope.make())
  const first = scriptedGeneration("generation-a")
  const runtimeFailure = new MusicSessionRuntimeError({
    operation: "inspect",
    path: "/tmp/music-session-test",
    message: "unsafe runtime",
  })
  let attempts = 0
  try {
    const managed = await Effect.runPromise(
      createReconnectingMusicSessionClientEffect(
        { clientId: "replacement-runtime", hostKind: "test" },
        {
          connect: () => {
            attempts++
            return attempts === 1
              ? Effect.succeed(first.client)
              : Effect.fail(runtimeFailure)
          },
        },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const terminal = new Promise<void>((resolve) => {
      managed.subscribeConnection((state) => {
        if (state.type === "terminal") resolve()
      })
    })
    first.terminal(
      new MusicSessionClientError({
        code: "CONNECTION_LOST",
        message: "generation A disappeared",
        retryable: true,
      }),
    )
    await terminal
    expect(managed.connection).toEqual({
      type: "terminal",
      error: runtimeFailure,
    })
    expect(attempts).toBe(2)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

test("reconnecting disposal interrupts a TestClock replacement sleep", async () => {
  const scope = await Effect.runPromise(Scope.make())
  const clock = await Effect.runPromise(
    TestClock.make().pipe(Effect.provideService(Scope.Scope, scope)),
  )
  const first = scriptedGeneration("generation-a")
  let attempts = 0
  let replacementStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    replacementStarted = resolve
  })
  try {
    const managed = await Effect.runPromise(
      createReconnectingMusicSessionClientEffect(
        { clientId: "replacement-dispose", hostKind: "test" },
        {
          connect: () => {
            attempts++
            if (attempts === 1) return Effect.succeed(first.client)
            return Effect.gen(function* () {
              replacementStarted?.()
              yield* Effect.sleep("1 hour")
              throw new Error("interrupted replacement slept to completion")
            })
          },
        },
      ).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(Clock.Clock, clock),
      ),
    )
    first.terminal(
      new MusicSessionClientError({
        code: "CONNECTION_LOST",
        message: "generation A disappeared",
        retryable: true,
      }),
    )
    await started
    await managed.dispose()
    await Effect.runPromise(clock.adjust("1 day"))
    expect(attempts).toBe(2)
    expect(managed.connection.type).toBe("disposed")
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

test("reconnecting uses the bounded Phase 3 schedule without a busy loop", async () => {
  const scope = await Effect.runPromise(Scope.make())
  const clock = await Effect.runPromise(
    TestClock.make().pipe(Effect.provideService(Scope.Scope, scope)),
  )
  const first = scriptedGeneration("generation-a")
  const runtime = resolveMusicSessionRuntimePaths({
    root: "/tmp",
    uid: process.getuid?.() ?? -1,
  })
  const replacementAttempt = Latch.makeUnsafe()
  const lease = {
    paths: runtime,
    attemptToken: "reconnect-test-lease",
    release: async () => {},
  }
  let connects = 0
  let startupAttempts = 0
  let launches = 0
  try {
    const managed = await Effect.runPromise(
      createReconnectingMusicSessionClientEffect(
        {
          runtime,
          clientId: "replacement-schedule",
          hostKind: "test",
          startup: { attempts: 3, initialDelayMs: 10, maxDelayMs: 20 },
        },
        {
          connect: (options) => {
            connects++
            if (connects === 1) return Effect.succeed(first.client)
            return connectOrStartMusicSessionEffect(
              {
                ...options,
                launcher: async () => {
                  launches++
                },
              },
              {
                discover: async () => ({ type: "missing" }),
                acquireLease: async () => ({ type: "acquired", lease }),
                onAttempt: () => {
                  startupAttempts++
                  Latch.openUnsafe(replacementAttempt)
                },
              },
            )
          },
        },
      ).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(Clock.Clock, clock),
        Random.withSeed("reconnect-pacing"),
      ),
    )
    const terminal = new Promise<void>((resolve) => {
      managed.subscribeConnection((state) => {
        if (state.type === "terminal") resolve()
      })
    })
    first.terminal(
      new MusicSessionClientError({
        code: "CONNECTION_LOST",
        message: "generation A disappeared",
        retryable: true,
      }),
    )
    await Effect.runPromise(Latch.await(replacementAttempt))
    expect(connects).toBe(2)
    expect(startupAttempts).toBe(1)
    await Effect.runPromise(clock.adjust("5 millis"))
    expect(startupAttempts).toBe(1)
    await Effect.runPromise(clock.adjust("1 hour"))
    await terminal
    expect(startupAttempts).toBe(3)
    expect(launches).toBe(1)
    expect(managed.connection).toMatchObject({
      type: "terminal",
      error: { _tag: "MusicSession.StartupError", operation: "timeout" },
    })
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

test("managed launcher uses detached packaged entry and releases its child handle", async () => {
  const listeners = new Map<string, (cause?: Error) => void>()
  const removed: string[] = []
  let unrefs = 0
  let invocation:
    | {
        readonly command: string
        readonly args: readonly string[]
        readonly options: unknown
      }
    | undefined
  const runtime = resolveMusicSessionRuntimePaths({
    root: "/tmp",
    uid: 1000,
  })
  const launched = launchManagedMusicSessionDaemon(runtime, {
    entry: () => "/absolute/music-sessiond.js",
    spawn: (command, args, options) => {
      invocation = { command, args, options }
      return {
        once: (event, listener) => {
          listeners.set(event, listener as (cause?: Error) => void)
        },
        off: (event) => {
          removed.push(event)
        },
        stderr: {
          on: () => {},
          off: () => {},
          unref: () => {},
        },
        unref: () => {
          unrefs++
        },
      }
    },
  })
  await Promise.resolve()
  listeners.get("spawn")?.()
  await launched
  // Production selects the daemon runtime through the same seam hosts use.
  // On embedded Bun (OpenCode/Windows CI) that may be "node", not execPath.
  expect(invocation).toEqual({
    command: resolveMusicSessionDaemonRuntime(),
    args: ["/absolute/music-sessiond.js"],
    options: {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
      env: { PATH: process.env.PATH ?? "" },
    },
  })
  expect(removed).toEqual(["spawn", "error"])
  expect(unrefs).toBe(1)
})

test("daemon runtime selection accepts Node and Bun CLI but rejects embedded Bun", () => {
  expect(
    resolveMusicSessionDaemonRuntime({
      execPath: "/runtime/node",
      release: { name: "node" },
      versions: {},
    }),
  ).toBe("/runtime/node")
  expect(
    resolveMusicSessionDaemonRuntime({
      execPath: "/runtime/bun",
      release: { name: "node" },
      versions: { bun: "1.3.7" },
    }),
  ).toBe("/runtime/bun")
  expect(
    resolveMusicSessionDaemonRuntime({
      execPath: "/runtime/opencode2",
      release: { name: "node" },
      versions: { bun: "1.3.7" },
    }),
  ).toBe("node")
})

test("managed launcher retains bounded daemon diagnostics for early exit", async () => {
  class Child extends EventEmitter {
    readonly stderr = new EventEmitter()
    unref() {}
  }
  const child = new Child()
  const runtime = resolveMusicSessionRuntimePaths({
    root: "/tmp",
    uid: 1000,
  })
  const launched = launchManagedMusicSessionDaemon(runtime, {
    entry: () => "/absolute/music-sessiond.js",
    spawn: () => child,
  })
  await Promise.resolve()
  child.emit("spawn")
  const launch = await launched
  child.stderr.emit(
    "data",
    new TextEncoder().encode(
      `ignored PLAYBACK_SENTINEL ARTWORK_SENTINEL ENV_SENTINEL ${"x".repeat(1_000)}\n`,
    ),
  )
  child.stderr.emit("data", new TextEncoder().encode("music-sessiond: first\r"))
  child.stderr.emit("data", new TextEncoder().encode("\nmusic-sessiond: early"))
  child.stderr.emit("data", new TextEncoder().encode(" failure\n"))
  child.stderr.emit(
    "data",
    new TextEncoder().encode(`music-sessiond: ${"x".repeat(300)}`),
  )
  child.stderr.emit("data", new TextEncoder().encode("x".repeat(300)))
  child.stderr.emit("data", new TextEncoder().encode("\n"))
  child.emit("exit", 23, null)
  expect(launch.earlyFailure()).toMatchObject({
    _tag: "MusicSession.StartupError",
    operation: "exit",
    exitCode: 23,
  })
  expect(launch.earlyFailure()?.diagnostic).toContain("music-sessiond: first")
  expect(launch.earlyFailure()?.diagnostic).toContain(
    "music-sessiond: early failure",
  )
  expect(launch.earlyFailure()?.diagnostic).not.toContain("ignored")
  expect(launch.earlyFailure()?.diagnostic).not.toContain("PLAYBACK_SENTINEL")
  expect(launch.earlyFailure()?.diagnostic).not.toContain("ARTWORK_SENTINEL")
  expect(launch.earlyFailure()?.diagnostic).not.toContain("ENV_SENTINEL")
  expect(
    Buffer.byteLength(launch.earlyFailure()?.diagnostic ?? "", "utf8"),
  ).toBeLessThanOrEqual(512)
  expect(launch.earlyFailure()?.diagnostic).toContain("music-sessiond: x")
})

test("managed launcher truncates diagnostics on a valid UTF-8 boundary", async () => {
  class Child extends EventEmitter {
    readonly stderr = new EventEmitter()
    unref() {}
  }
  const child = new Child()
  const runtime = resolveMusicSessionRuntimePaths({
    root: "/tmp",
    uid: 1000,
  })
  const launched = launchManagedMusicSessionDaemon(runtime, {
    entry: () => "/absolute/music-sessiond.js",
    spawn: () => child,
  })
  await Promise.resolve()
  child.emit("spawn")
  const launch = await launched
  child.stderr.emit(
    "data",
    Buffer.concat([
      Buffer.from(`music-sessiond: ${"x".repeat(495)}`),
      Buffer.from("😀"),
    ]),
  )
  child.emit("exit", 23, null)
  const diagnostic = launch.earlyFailure()?.diagnostic
  expect(diagnostic).toStartWith("music-sessiond:")
  expect(diagnostic).not.toContain("�")
  expect(Buffer.byteLength(diagnostic ?? "", "utf8")).toBeLessThanOrEqual(512)
})

test("managed launcher recognizes readiness only after a split complete line", async () => {
  class Child extends EventEmitter {
    readonly stderr = new EventEmitter()
    unref() {}
  }
  const child = new Child()
  const runtime = resolveMusicSessionRuntimePaths({
    root: "/tmp",
    uid: 1000,
  })
  const launched = launchManagedMusicSessionDaemon(runtime, {
    entry: () => "/absolute/music-sessiond.js",
    spawn: () => child,
  })
  await Promise.resolve()
  child.emit("spawn")
  const launch = await launched
  child.stderr.emit("data", new TextEncoder().encode("music-sessiond liste"))
  expect(launch.ready()).toBe(false)
  child.stderr.emit("data", new TextEncoder().encode("ning on /tmp/s.sock\r"))
  expect(launch.ready()).toBe(false)
  child.stderr.emit("data", new TextEncoder().encode("\n"))
  expect(launch.ready()).toBe(true)
  child.emit("exit", 23, null)
  expect(launch.earlyFailure()).toBeUndefined()
})

test("managed launcher reports synchronous and initial spawn failures", async () => {
  const runtime = resolveMusicSessionRuntimePaths({
    root: "/tmp",
    uid: 1000,
  })
  await expect(
    launchManagedMusicSessionDaemon(runtime, {
      entry: () => "/absolute/music-sessiond.js",
      spawn: () => {
        throw new Error("spawn throw")
      },
    }),
  ).rejects.toMatchObject({
    operation: "spawn",
    message: "unable to spawn music session daemon",
  })

  const listeners = new Map<string, (cause?: Error) => void>()
  const launched = launchManagedMusicSessionDaemon(runtime, {
    entry: () => "/absolute/music-sessiond.js",
    spawn: () => ({
      once: (event, listener) => {
        listeners.set(event, listener as (cause?: Error) => void)
      },
      off: () => {},
      stderr: { on: () => {}, off: () => {}, unref: () => {} },
      unref: () => {},
    }),
  })
  await Promise.resolve()
  listeners.get("error")?.(new Error("initial error"))
  await expect(launched).rejects.toMatchObject({ operation: "spawn" })
})

test("explicit client requires a socket", async () => {
  await expect(
    createMusicSessionClient({
      socketPath: "",
      clientId: "x",
      hostKind: "test",
    }),
  ).rejects.toBeInstanceOf(MusicSessionClientError)
})

test("managed runtime resolver and preparation keep a compact owner-only layout", async () => {
  const root = await mkdtemp("/tmp/music-session-runtime-")
  try {
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid: process.getuid?.() ?? -1,
    })
    expect(runtime.directory).toBe(
      `${root}/naxodev-music-${process.getuid?.() ?? -1}`,
    )
    expect(runtime.socketPath).toBe(`${runtime.directory}/s.sock`)
    expect(runtime.markerPath).toBe(`${runtime.directory}/start.lock`)
    expect(
      Buffer.byteLength(runtime.socketPath, "utf8") + 1,
    ).toBeLessThanOrEqual(104)
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    const directory = await lstat(runtime.directory)
    expect(directory.isDirectory()).toBe(true)
    expect(directory.mode & 0o077).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("managed runtime rejects wrong-mode and symlinked roots without repair", async () => {
  const root = await mkdtemp("/tmp/music-session-runtime-unsafe-")
  try {
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid: process.getuid?.() ?? -1,
    })
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    await chmod(runtime.directory, 0o755)
    await expect(
      Effect.runPromise(prepareManagedRuntimeDirectory(runtime)),
    ).rejects.toBeInstanceOf(MusicSessionRuntimeError)
    expect((await lstat(runtime.directory)).mode & 0o777).toBe(0o755)

    await rm(runtime.directory, { recursive: true })
    const target = `${root}/target`
    await writeFile(target, "not a directory")
    await symlink(target, runtime.directory)
    await expect(
      Effect.runPromise(prepareManagedRuntimeDirectory(runtime)),
    ).rejects.toBeInstanceOf(MusicSessionRuntimeError)
    expect((await lstat(runtime.directory)).isSymbolicLink()).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("managed discovery rejects unsafe socket artifacts without connecting or removing them", async () => {
  for (const kind of ["file", "symlink", "wrong-mode"] as const) {
    const root = await mkdtemp(`/tmp/music-session-runtime-artifact-${kind}-`)
    try {
      const runtime = resolveMusicSessionRuntimePaths({
        root,
        uid: process.getuid?.() ?? -1,
      })
      await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
      if (kind === "symlink") {
        const target = `${root}/socket-target`
        await writeFile(target, "not a socket", { mode: 0o600 })
        await symlink(target, runtime.socketPath)
      } else if (kind === "wrong-mode") {
        await leaveStaleSocket(runtime)
        await chmod(runtime.socketPath, 0o644)
      } else {
        await writeFile(runtime.socketPath, "not a socket", { mode: 0o600 })
      }
      const before = await lstat(runtime.socketPath)
      await expect(
        discoverMusicSession({ runtime, clientId: kind, hostKind: "test" }),
      ).rejects.toBeInstanceOf(MusicSessionRuntimeError)
      const after = await lstat(runtime.socketPath)
      expect(after.dev).toBe(before.dev)
      expect(after.ino).toBe(before.ino)
      expect(after.mode).toBe(before.mode)
      expect(
        kind === "symlink"
          ? after.isSymbolicLink()
          : kind === "wrong-mode"
            ? after.isSocket()
            : after.isFile(),
      ).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("managed runtime rejects non-directory and simulated foreign-owned roots without repair", async () => {
  const root = await mkdtemp("/tmp/music-session-runtime-root-")
  try {
    const uid = process.getuid?.() ?? -1
    const runtime = resolveMusicSessionRuntimePaths({ root, uid })
    await writeFile(runtime.directory, "not a directory", { mode: 0o600 })
    const file = await lstat(runtime.directory)
    await expect(
      Effect.runPromise(prepareManagedRuntimeDirectory(runtime)),
    ).rejects.toBeInstanceOf(MusicSessionRuntimeError)
    expect((await lstat(runtime.directory)).ino).toBe(file.ino)
    await rm(runtime.directory)

    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    const foreignRuntime = resolveMusicSessionRuntimePaths({
      root,
      uid,
      dependencies: {
        lstat: (async (path) => {
          const stat = await lstat(path)
          return path === runtime.directory
            ? new Proxy(stat, {
                get(target, property, receiver) {
                  return property === "uid"
                    ? uid + 1
                    : Reflect.get(target, property, receiver)
                },
              })
            : stat
        }) as typeof lstat,
      },
    })
    const before = await lstat(runtime.directory)
    await expect(
      Effect.runPromise(prepareManagedRuntimeDirectory(foreignRuntime)),
    ).rejects.toBeInstanceOf(MusicSessionRuntimeError)
    const after = await lstat(runtime.directory)
    expect(after.ino).toBe(before.ino)
    expect(after.mode).toBe(before.mode)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("exclusive startup marker lease has one winner and preserves replacements", async () => {
  // Why: singleton ownership is filesystem-exclusive. Concurrent acquirers must
  // collapse to one lease, and a replaced generation must stay foreign to the
  // old lease so release cannot delete a successor's marker (even when Linux
  // recycles the inode number after unlink+create).
  const root = await mkdtemp("/tmp/music-session-lease-")
  try {
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid: process.getuid?.() ?? -1,
    })
    const leases = await Promise.all(
      Array.from({ length: 20 }, () => acquireStartupMarkerLease(runtime)),
    )
    const acquired = leases.filter(
      (result): result is Extract<typeof result, { type: "acquired" }> =>
        result.type === "acquired",
    )
    expect(acquired).toHaveLength(1)
    expect(leases.filter((result) => result.type === "contended")).toHaveLength(
      19,
    )
    const firstToken = acquired[0]!.lease.attemptToken
    await acquired[0]!.lease.release()
    await acquired[0]!.lease.release()
    await expect(lstat(runtime.markerPath)).rejects.toMatchObject({
      code: "ENOENT",
    })

    const replacement = await acquireStartupMarkerLease(runtime)
    if (replacement.type !== "acquired") throw new Error("lease contention")
    const ownedToken = replacement.lease.attemptToken
    // Hold the owned inode open so unlink+create cannot recycle it. The
    // successor generation must remain a distinct identity even on Linux.
    const heldInode = await open(runtime.markerPath, "r")
    try {
      await rm(runtime.markerPath)
      const foreignToken = `foreign-${randomUUID()}`
      await writeFile(
        runtime.markerPath,
        JSON.stringify({
          version: 1,
          uid: runtime.uid,
          pid: process.pid,
          attemptToken: foreignToken,
        }),
        { mode: 0o600 },
      )
      await chmod(runtime.markerPath, 0o600)
      // Discovery with the old lease must treat the live foreign marker as
      // starting, never as owned/missing: waiters converge on the successor.
      const replacementDiscovery = await discoverMusicSession({
        runtime,
        ownedLease: replacement.lease,
        clientId: "replacement",
        hostKind: "test",
      })
      expect(replacementDiscovery.type).toBe("starting")
      await expect(replacement.lease.release()).rejects.toBeInstanceOf(
        MusicSessionRuntimeError,
      )
      const markerBody = await readFile(runtime.markerPath, "utf8")
      expect(markerBody).toContain(foreignToken)
      expect(markerBody).not.toContain(ownedToken)
      expect(markerBody).not.toContain(firstToken)
      expect(existsSync(runtime.markerPath)).toBe(true)
    } finally {
      await heldInode.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("connect-or-start acquires one marker, launches once, and returns a hello client", async () => {
  const root = await mkdtemp("/tmp/music-session-connect-start-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  const provider = createFakeProvider()
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let client: Awaited<ReturnType<typeof connectOrStartMusicSession>> | undefined
  let launches = 0
  try {
    client = await connectOrStartMusicSession({
      runtime,
      clientId: "starter",
      hostKind: "test",
      launcher: async () => {
        launches++
        server = await startMusicSessionServer({ runtime }, provider)
      },
    })
    expect(launches).toBe(1)
    expect(client.daemonInstanceId).not.toBe("")
    expect(existsSync(runtime.markerPath)).toBe(false)
  } finally {
    client?.dispose()
    await server?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("reconnecting client adopts one replacement generation without replay", async () => {
  const root = await mkdtemp("/tmp/music-session-reconnect-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  const firstProvider = createFakeProvider()
  const secondProvider = createFakeProvider()
  let first: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let second: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let launches = 0
  let client:
    Awaited<ReturnType<typeof createReconnectingMusicSessionClient>> | undefined
  try {
    client = await createReconnectingMusicSessionClient({
      runtime,
      clientId: "reconnecting",
      hostKind: "test",
      maxPendingRequests: 1,
      startup: { attempts: 8, initialDelayMs: 5, maxDelayMs: 10 },
      launcher: async () => {
        launches++
        if (launches === 1)
          first = await startMusicSessionServer({ runtime }, firstProvider)
        else second = await startMusicSessionServer({ runtime }, secondProvider)
      },
    })
    const firstInstance = client.daemonInstanceId
    const lifecycle: string[] = []
    const states: number[] = []
    let connectedReplacement: (() => void) | undefined
    let reconnecting: (() => void) | undefined
    let stateFromA: (() => void) | undefined
    const replacement = new Promise<void>((resolve) => {
      connectedReplacement = resolve
    })
    const reconnectingSeen = new Promise<void>((resolve) => {
      reconnecting = resolve
    })
    const updatedA = new Promise<void>((resolve) => {
      stateFromA = resolve
    })
    client.subscribeConnection(() => {
      throw new Error("listener isolation")
    })
    client.subscribeConnection((state) => {
      lifecycle.push(state.type)
      if (state.type === "reconnecting") reconnecting?.()
      if (
        state.type === "connected" &&
        state.daemonInstanceId !== firstInstance
      )
        connectedReplacement?.()
    })
    client.subscribeState(() => {
      throw new Error("listener isolation")
    })
    client.subscribeState((state) => {
      states.push(state.revision)
      if (state.daemonInstanceId === firstInstance && state.revision > 1)
        stateFromA?.()
    })
    firstProvider.emit({
      type: "snapshot",
      state: { ...firstProvider.state, fetched_at: 1 },
    })
    firstProvider.emit({
      type: "snapshot",
      state: { ...firstProvider.state, fetched_at: 2 },
    })
    await updatedA
    const retainedState = client.state
    firstProvider.blockTransport()
    const pending = client.play()
    await expect(client.pause()).rejects.toMatchObject({ code: "SERVER_BUSY" })
    const closing = first!.close()
    await expect(pending).rejects.toMatchObject({
      code: "INDETERMINATE_COMMAND",
    })
    await reconnectingSeen
    expect(client.state).toEqual(retainedState)
    await expect(client.play()).rejects.toMatchObject({
      code: "CONNECTION_LOST",
      retryable: true,
    })
    const replayDuringReconnect: number[] = []
    const unsubscribeReplay = client.subscribeState((state) =>
      replayDuringReconnect.push(state.revision),
    )
    expect(replayDuringReconnect).toEqual([retainedState!.revision])
    unsubscribeReplay()
    unsubscribeReplay()
    await replacement
    expect(client.connection.type).toBe("connected")
    expect(client.daemonInstanceId).not.toBe(firstInstance)
    expect(launches).toBe(2)
    expect(client.state?.daemonInstanceId).toBe(client.daemonInstanceId)
    expect(client.state!.revision).toBeLessThan(retainedState!.revision)
    expect(states).toContain(retainedState!.revision)
    expect(replayDuringReconnect).toEqual([retainedState!.revision])
    expect(secondProvider.calls).toEqual([])
    expect(await client.play()).toEqual({ action: "play" })
    expect(secondProvider.calls).toEqual(["play"])
    expect(lifecycle).toEqual(["connected", "reconnecting", "connected"])
    firstProvider.releaseTransport()
    await closing
    await client.dispose()
    await client.dispose()
    expect(client.connection.type).toBe("disposed")
    await expect(client.play()).rejects.toMatchObject({ code: "DISPOSED" })
    expect(lifecycle).toEqual([
      "connected",
      "reconnecting",
      "connected",
      "disposed",
    ])
  } finally {
    await client?.dispose().catch(() => {})
    firstProvider.releaseTransport()
    await first?.close().catch(() => {})
    await second?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("reconnecting client adopts B only after A genuinely idles out", async () => {
  const root = await mkdtemp("/tmp/music-session-idle-reconnect-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  const firstProvider = createFakeProvider()
  const secondProvider = createFakeProvider()
  const accepted: net.Socket[] = []
  let first: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let second: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let closeScope: (() => Promise<void>) | undefined
  let managed: ReconnectingMusicSessionClient | undefined
  let firstUnlinked: (() => void) | undefined
  let replacementStarted: (() => void) | undefined
  const firstGone = new Promise<void>((resolve) => {
    firstUnlinked = resolve
  })
  const replacementWaiting = new Promise<void>((resolve) => {
    replacementStarted = resolve
  })
  const releaseReplacement = Deferred.makeUnsafe<void>()
  let connects = 0
  let launches = 0
  try {
    first = await startMusicSessionServer(
      { runtime, idleGraceMs: 25 },
      firstProvider,
      {
        onAccepted: (socket) => accepted.push(socket),
        onUnlink: () => firstUnlinked?.(),
      },
    )
    const scope = await Effect.runPromise(Scope.make())
    closeScope = () => Effect.runPromise(Scope.close(scope, Exit.void))
    managed = await Effect.runPromise(
      createReconnectingMusicSessionClientEffect(
        { runtime, clientId: "idle-replacement", hostKind: "test" },
        {
          connect: (options) => {
            connects++
            if (connects === 1)
              return Effect.promise(() =>
                createMusicSessionClient({
                  socketPath: runtime.socketPath,
                  clientId: options.clientId,
                  hostKind: options.hostKind,
                }),
              )
            return Effect.promise(() => firstGone).pipe(
              Effect.tap(() => Effect.sync(() => replacementStarted?.())),
              Effect.andThen(Deferred.await(releaseReplacement)),
              Effect.andThen(
                connectOrStartMusicSessionEffect({
                  ...options,
                  runtime,
                  launcher: async () => {
                    launches++
                    second = await startMusicSessionServer(
                      { runtime, idleGraceMs: 1_000 },
                      secondProvider,
                    )
                  },
                }),
              ),
            )
          },
        },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const firstId = managed.daemonInstanceId
    const retained = await new Promise<RevisionedState>((resolve) =>
      managed!.subscribeState(resolve),
    )
    accepted[0]?.destroy()
    await replacementWaiting
    expect(managed.connection.type).toBe("reconnecting")
    expect(managed.state).toEqual(retained)
    expect(existsSync(runtime.socketPath)).toBe(false)
    expect(firstProvider.counts).toMatchObject({
      disposals: 1,
      providerDisposals: 1,
    })
    Deferred.doneUnsafe(releaseReplacement, Effect.void)
    await new Promise<void>((resolve) => {
      managed!.subscribeConnection((state) => {
        if (state.type === "connected" && state.daemonInstanceId !== firstId)
          resolve()
      })
    })
    expect(managed.daemonInstanceId).not.toBe(firstId)
    expect(launches).toBe(1)
    expect(secondProvider.calls).toEqual([])
    expect(secondProvider.counts.subscriptions).toBe(1)
  } finally {
    await managed?.dispose().catch(() => {})
    await closeScope?.().catch(() => {})
    await first?.close().catch(() => {})
    await second?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("reconnecting before A's idle grace keeps the same generation", async () => {
  const root = await mkdtemp("/tmp/music-session-idle-rejoin-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  const provider = createFakeProvider()
  const accepted: net.Socket[] = []
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let closeScope: (() => Promise<void>) | undefined
  let managed: ReconnectingMusicSessionClient | undefined
  let connects = 0
  let launches = 0
  try {
    server = await startMusicSessionServer(
      { runtime, idleGraceMs: 100 },
      provider,
      { onAccepted: (socket) => accepted.push(socket) },
    )
    const scope = await Effect.runPromise(Scope.make())
    closeScope = () => Effect.runPromise(Scope.close(scope, Exit.void))
    managed = await Effect.runPromise(
      createReconnectingMusicSessionClientEffect(
        { runtime, clientId: "idle-rejoin", hostKind: "test" },
        {
          connect: (options) => {
            connects++
            if (connects === 1)
              return Effect.promise(() =>
                createMusicSessionClient({
                  socketPath: runtime.socketPath,
                  clientId: options.clientId,
                  hostKind: options.hostKind,
                }),
              )
            return connectOrStartMusicSessionEffect({
              ...options,
              runtime,
              launcher: async () => {
                launches++
                throw new Error("A should still be available after rejoin")
              },
            })
          },
        },
      ).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    const firstId = managed.daemonInstanceId
    accepted[0]?.destroy()
    await new Promise<void>((resolve) => {
      managed!.subscribeConnection((state) => {
        if (state.type === "connected" && connects === 2) resolve()
      })
    })
    expect(managed.daemonInstanceId).toBe(firstId)
    expect(connects).toBe(2)
    // Pass the canceled deadline: a stale A grace would unlink A and force
    // the Phase 3 launcher path above.
    await Effect.runPromise(Effect.sleep("150 millis"))
    expect(managed.daemonInstanceId).toBe(firstId)
    expect(launches).toBe(0)
    expect(existsSync(runtime.socketPath)).toBe(true)
    expect(provider.counts.providerDisposals).toBe(0)
  } finally {
    await managed?.dispose().catch(() => {})
    await closeScope?.().catch(() => {})
    await server?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("returned managed client does not relaunch after live server loss", async () => {
  const root = await mkdtemp("/tmp/music-session-no-reconnect-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let client: Awaited<ReturnType<typeof connectOrStartMusicSession>> | undefined
  let launches = 0
  try {
    client = await connectOrStartMusicSession({
      runtime,
      clientId: "no-reconnect",
      hostKind: "test",
      launcher: async () => {
        launches++
        server = await startMusicSessionServer(
          { runtime },
          createFakeProvider(),
        )
      },
    })
    await server!.close()
    server = undefined
    await expect(client.play()).rejects.toBeInstanceOf(MusicSessionClientError)
    expect(launches).toBe(1)
    expect(existsSync(runtime.socketPath)).toBe(false)
  } finally {
    client?.dispose()
    await server?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("20 concurrent managed callers converge on one selected graph", async () => {
  // Why: cross-host clients must share one daemon generation. A waiter that
  // inspects before the socket exists and revalidates after bind must keep
  // waiting (starting), not die as occupied — otherwise OpenCode/Pi cannot
  // converge under concurrent connect-or-start.
  const root = await mkdtemp("/tmp/music-session-convergence-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  const provider = createFakeProvider()
  const clients: Awaited<ReturnType<typeof connectOrStartMusicSession>>[] = []
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let launches = 0
  let listeners = 0
  let coordinators = 0
  try {
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, async (_, index) => {
        const client = await connectOrStartMusicSession({
          runtime,
          clientId: `concurrent-${index}`,
          hostKind: index % 2 === 0 ? "opencode" : "pi",
          startup: { attempts: 12, initialDelayMs: 5, maxDelayMs: 40 },
          launcher: async () => {
            launches++
            server = await startMusicSessionServer({ runtime }, provider, {
              onListener: () => listeners++,
              onCoordinator: () => coordinators++,
            })
          },
        })
        clients.push(client)
        return client
      }),
    )
    const rejected = settled.find((result) => result.status === "rejected")
    if (rejected?.status === "rejected") throw rejected.reason
    const started = settled.map((result) => {
      if (result.status !== "fulfilled") throw new Error("unreachable")
      return result.value
    })
    expect(launches).toBe(1)
    expect(listeners).toBe(1)
    expect(coordinators).toBe(1)
    expect(provider.counts.subscriptions).toBe(1)
    expect(provider.counts.samples).toBe(1)
    expect(existsSync(runtime.markerPath)).toBe(false)
    expect(new Set(started.map((client) => client.daemonInstanceId)).size).toBe(
      1,
    )
    expect(started[0]?.daemonInstanceId).not.toBe("")
    expect(new Set(started.map((client) => client.selectedRevision)).size).toBe(
      1,
    )

    clients.shift()?.dispose()
    expect(await clients[0]!.play()).toEqual({ action: "play" })
    expect(provider.calls).toEqual(["play"])
    for (const client of clients.splice(0)) client.dispose()
    await server?.close()
    server = undefined
    expect(provider.counts.disposals).toBe(1)
    expect(provider.counts.providerDisposals).toBe(1)
    expect(existsSync(runtime.socketPath)).toBe(false)
    expect(existsSync(runtime.markerPath)).toBe(false)
    const entries = await readdir(runtime.directory)
    const bindReservation = `${runtime.socketPath.split("/").at(-1)}.bind-lock`
    expect(entries.filter((name) => name.startsWith(bindReservation))).toEqual(
      [],
    )
    const markerTemporary = `${runtime.markerPath.split("/").at(-1)}.`
    expect(
      entries.filter(
        (name) => name.startsWith(markerTemporary) && name.endsWith(".tmp"),
      ),
    ).toEqual([])
  } finally {
    for (const client of clients) client.dispose()
    await server?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("discovery keeps waiting when a live marker's socket appears mid-probe", async () => {
  // Why: concurrent connect-or-start waiters often inspect while only the
  // startup marker exists. If the winner binds the socket between inspect and
  // revalidation, classifying that as occupied would kill waiters that should
  // converge on the single generation.
  const root = await mkdtemp("/tmp/music-session-socket-appears-")
  let server: net.Server | undefined
  try {
    const uid = process.getuid?.() ?? -1
    const base = resolveMusicSessionRuntimePaths({ root, uid })
    await Effect.runPromise(prepareManagedRuntimeDirectory(base))
    await writeFile(
      base.markerPath,
      JSON.stringify({
        version: 1,
        uid,
        pid: process.pid,
        attemptToken: "live-start",
      }),
      { mode: 0o600 },
    )
    await chmod(base.markerPath, 0o600)
    let socketStats = 0
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid,
      dependencies: {
        lstat: (async (path) => {
          if (path === base.socketPath) {
            socketStats++
            // After the initial endpoint inspect misses the socket, bind it so
            // the absent() revalidation observes a newly appeared endpoint.
            if (socketStats === 1) {
              try {
                await lstat(path)
              } catch (cause: unknown) {
                if (
                  typeof cause === "object" &&
                  cause !== null &&
                  "code" in cause &&
                  cause.code === "ENOENT"
                ) {
                  server = net.createServer((socket) => socket.destroy())
                  await new Promise<void>((resolve, reject) => {
                    server!.once("error", reject)
                    server!.listen(base.socketPath, resolve)
                  })
                  await chmod(base.socketPath, 0o600)
                }
                throw cause
              }
            }
          }
          return lstat(path)
        }) as typeof lstat,
      },
    })
    const found = await discoverMusicSession({
      runtime,
      clientId: "socket-appears",
      hostKind: "test",
    })
    expect(found.type).toBe("starting")
    expect(existsSync(base.markerPath)).toBe(true)
    expect(existsSync(base.socketPath)).toBe(true)
  } finally {
    await new Promise<void>(
      (resolve) => server?.close(() => resolve()) ?? resolve(),
    )
    await rm(root, { recursive: true, force: true })
  }
})

test("marker release failure disposes a successful client and remains observable", async () => {
  const root = await mkdtemp("/tmp/music-session-release-failure-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
    dependencies: {
      unlink: async () => {
        throw new Error("release failure")
      },
    },
  })
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  const releaseFailures: unknown[] = []
  let disposed = 0
  try {
    await expect(
      Effect.runPromise(
        connectOrStartMusicSessionEffect(
          {
            runtime,
            clientId: "release-failure",
            hostKind: "test",
            startup: { attempts: 4, initialDelayMs: 10, maxDelayMs: 20 },
            launcher: async () => {
              server = await startMusicSessionServer(
                { runtime },
                createFakeProvider(),
              )
            },
          },
          {
            discover: async (options) => {
              const found = await discoverMusicSession(options)
              if (found.type !== "healthy") return found
              return {
                ...found,
                client: new Proxy(found.client, {
                  get(target, property, receiver) {
                    if (property === "dispose")
                      return () => {
                        disposed++
                        target.dispose()
                      }
                    return Reflect.get(target, property, receiver)
                  },
                }),
              }
            },
            onReleaseFailure: (error) => releaseFailures.push(error),
          },
        ),
      ),
    ).rejects.toBeInstanceOf(MusicSessionRuntimeError)
    expect(releaseFailures).toHaveLength(1)
    expect(disposed).toBe(1)
    expect(existsSync(runtime.markerPath)).toBe(true)
  } finally {
    await server?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("owned daemon readiness closes the transient hello-reset window", async () => {
  const runtime = resolveMusicSessionRuntimePaths({
    root: "/tmp",
    uid: process.getuid?.() ?? -1,
  })
  const generation = scriptedGeneration("startup-generation")
  const lease = {
    paths: runtime,
    attemptToken: "owned-startup-window",
    release: async () => {},
  }
  let attempts = 0
  let discoveries = 0
  let launches = 0
  let ready = false
  const client = await Effect.runPromise(
    connectOrStartMusicSessionEffect(
      {
        runtime,
        clientId: "owned-startup-window",
        hostKind: "test",
        startup: { attempts: 5, initialDelayMs: 1, maxDelayMs: 1 },
        launcher: async () => {
          launches++
          return { ready: () => ready, earlyFailure: () => undefined }
        },
      },
      {
        acquireLease: async () => ({ type: "acquired", lease }),
        onAttempt: () => {
          attempts++
          if (attempts === 4) ready = true
        },
        discover: async () => {
          discoveries++
          return discoveries < 3
            ? { type: "missing" }
            : { type: "healthy", client: generation.client }
        },
      },
    ),
  )
  expect(client).toBe(generation.client)
  expect(launches).toBe(1)
  // The startup's third attempt observed readiness=false and did not probe.
  expect(discoveries).toBe(3)
  client.dispose()
})

test("a managed child early exit reaches acquisition without becoming timeout", async () => {
  class Child extends EventEmitter {
    readonly stderr = new EventEmitter()
    unref() {}
  }
  const child = new Child()
  const runtime = resolveMusicSessionRuntimePaths({
    root: "/tmp",
    uid: process.getuid?.() ?? -1,
  })
  const lease = {
    paths: runtime,
    attemptToken: "early-exit-boundary",
    release: async () => {},
  }
  let discoveries = 0
  await expect(
    Effect.runPromise(
      connectOrStartMusicSessionEffect(
        {
          runtime,
          clientId: "early-exit-boundary",
          hostKind: "test",
          startup: { attempts: 5, initialDelayMs: 1, maxDelayMs: 1 },
          launcher: (paths) =>
            launchManagedMusicSessionDaemon(paths, {
              entry: () => "/absolute/music-sessiond.js",
              spawn: () => {
                queueMicrotask(() => {
                  child.emit("spawn")
                  child.stderr.emit(
                    "data",
                    new TextEncoder().encode("music-sessiond: early"),
                  )
                  child.stderr.emit(
                    "data",
                    new TextEncoder().encode(" failure\n"),
                  )
                  child.emit("exit", 23, "SIGTERM")
                })
                return child
              },
            }),
        },
        {
          acquireLease: async () => ({ type: "acquired", lease }),
          discover: async () => {
            discoveries++
            return { type: "missing" }
          },
        },
      ),
    ),
  ).rejects.toMatchObject({
    operation: "exit",
    exitCode: 23,
    signal: "SIGTERM",
    diagnostic: "music-sessiond: early failure",
  })
  expect(discoveries).toBe(2)
})

test("a peer remains terminal occupied after the launched daemon is ready", async () => {
  const runtime = resolveMusicSessionRuntimePaths({
    root: "/tmp",
    uid: process.getuid?.() ?? -1,
  })
  const lease = {
    paths: runtime,
    attemptToken: "ready-peer",
    release: async () => {},
  }
  let discoveries = 0
  await expect(
    Effect.runPromise(
      connectOrStartMusicSessionEffect(
        {
          runtime,
          clientId: "ready-peer",
          hostKind: "test",
          startup: { attempts: 5, initialDelayMs: 1, maxDelayMs: 1 },
          launcher: async () => ({
            ready: () => true,
            earlyFailure: () => undefined,
          }),
        },
        {
          acquireLease: async () => ({ type: "acquired", lease }),
          discover: async () => {
            discoveries++
            return discoveries < 3 ? { type: "missing" } : { type: "occupied" }
          },
        },
      ),
    ),
  ).rejects.toMatchObject({ operation: "occupied" })
  expect(discoveries).toBe(3)
})

test("marker is released after startup timeout and interruption", async () => {
  const root = await mkdtemp("/tmp/music-session-marker-finalization-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  try {
    await expect(
      Effect.runPromise(
        connectOrStartMusicSessionEffect(
          {
            runtime,
            clientId: "timeout-release",
            hostKind: "test",
            startup: { attempts: 2, initialDelayMs: 5, maxDelayMs: 5 },
            launcher: async () => {},
          },
          { discover: async () => ({ type: "missing" }) },
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "MusicSession.StartupError",
      operation: "timeout",
    })
    expect(existsSync(runtime.markerPath)).toBe(false)

    const acquired = Latch.makeUnsafe()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* connectOrStartMusicSessionEffect(
            {
              runtime,
              clientId: "interrupt-release",
              hostKind: "test",
              startup: { attempts: 3, initialDelayMs: 100, maxDelayMs: 100 },
            },
            {
              discover: async () => ({ type: "missing" }),
              acquireLease: async (paths) => {
                const next = await acquireStartupMarkerLease(paths)
                Latch.openUnsafe(acquired)
                return next
              },
            },
          ).pipe(Effect.forkScoped)
          yield* Latch.await(acquired)
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )
    expect(existsSync(runtime.markerPath)).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("launcher rejection releases its owned marker", async () => {
  const root = await mkdtemp("/tmp/music-session-launcher-finalization-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  let launches = 0
  try {
    await expect(
      connectOrStartMusicSession({
        runtime,
        clientId: "launcher-rejection",
        hostKind: "test",
        startup: { attempts: 3, initialDelayMs: 1, maxDelayMs: 1 },
        launcher: async () => {
          launches++
          throw new Error("launcher rejected")
        },
      }),
    ).rejects.toThrow("launcher rejected")
    expect(launches).toBe(1)
    expect(existsSync(runtime.markerPath)).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("primary startup failure remains primary when marker release fails", async () => {
  const root = await mkdtemp("/tmp/music-session-primary-release-failure-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
    dependencies: {
      unlink: async () => {
        throw new Error("release failure")
      },
    },
  })
  const releaseFailures: unknown[] = []
  let launches = 0
  try {
    await expect(
      Effect.runPromise(
        connectOrStartMusicSessionEffect(
          {
            runtime,
            clientId: "primary-release-failure",
            hostKind: "test",
            startup: { attempts: 2, initialDelayMs: 1, maxDelayMs: 1 },
            launcher: async () => {
              launches++
            },
          },
          {
            discover: async () => ({ type: "missing" }),
            onReleaseFailure: (error) => releaseFailures.push(error),
          },
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "MusicSession.StartupError",
      operation: "timeout",
    })
    expect(launches).toBe(1)
    expect(releaseFailures).toHaveLength(1)
    expect(releaseFailures[0]).toBeInstanceOf(MusicSessionRuntimeError)
    expect(existsSync(runtime.markerPath)).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("workflow marker release does not remove a replacement marker", async () => {
  const root = await mkdtemp("/tmp/music-session-marker-replacement-workflow-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  const releaseFailures: unknown[] = []
  let replacement: { readonly dev: number; readonly ino: number } | undefined
  try {
    await expect(
      Effect.runPromise(
        connectOrStartMusicSessionEffect(
          {
            runtime,
            clientId: "replacement-release",
            hostKind: "test",
            startup: { attempts: 3, initialDelayMs: 1, maxDelayMs: 1 },
            launcher: async () => {
              throw new Error("launcher rejected after replacement")
            },
          },
          {
            discover: async () => ({ type: "missing" }),
            acquireLease: async (paths) => {
              const acquired = await acquireStartupMarkerLease(paths)
              if (acquired.type !== "acquired") return acquired
              await rename(paths.markerPath, `${root}/original-marker`)
              await writeFile(
                paths.markerPath,
                JSON.stringify({
                  version: 1,
                  uid: paths.uid,
                  pid: process.pid,
                  attemptToken: "replacement",
                }),
                { mode: 0o600 },
              )
              replacement = await lstat(paths.markerPath)
              return acquired
            },
            onReleaseFailure: (error) => releaseFailures.push(error),
          },
        ),
      ),
    ).rejects.toThrow("launcher rejected after replacement")
    if (!replacement) throw new Error("replacement marker was not installed")
    const current = await lstat(runtime.markerPath)
    expect([current.dev, current.ino]).toEqual([
      replacement.dev,
      replacement.ino,
    ])
    expect(
      JSON.parse(await readFile(runtime.markerPath, "utf8")),
    ).toMatchObject({
      attemptToken: "replacement",
    })
    expect(releaseFailures).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("incompatible managed startup is terminal after marker acquisition", async () => {
  const root = await mkdtemp("/tmp/music-session-startup-incompatible-owned-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  const provider = createFakeProvider()
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let supported:
    Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  let identity:
    | { readonly dev: number; readonly ino: number; readonly mode: number }
    | undefined
  let launches = 0
  let attempts = 0
  try {
    await expect(
      Effect.runPromise(
        connectOrStartMusicSessionEffect(
          {
            runtime,
            clientId: "incompatible-owned",
            hostKind: "test",
            protocolRange: { major: 1, minRevision: 9, maxRevision: 10 },
            startup: { attempts: 5, initialDelayMs: 5, maxDelayMs: 10 },
            launcher: async () => {
              launches++
              server = await startMusicSessionServer({ runtime }, provider)
              supported = await createMusicSessionClient({
                socketPath: runtime.socketPath,
                clientId: "supported-during-owned-incompatible",
                hostKind: "test",
              })
              identity = await lstat(runtime.socketPath)
            },
          },
          { onAttempt: () => attempts++ },
        ),
      ),
    ).rejects.toMatchObject({
      code: "INCOMPATIBLE_PROTOCOL",
      details: {
        client: { minRevision: 9, maxRevision: 10 },
        daemon: { minRevision: 0, maxRevision: 1 },
      },
    })
    expect(launches).toBe(1)
    expect(attempts).toBe(3)
    expect(existsSync(runtime.markerPath)).toBe(false)
    expect(await supported!.play()).toEqual({ action: "play" })
    const after = await lstat(runtime.socketPath)
    expect([after.dev, after.ino, after.mode]).toEqual([
      identity!.dev,
      identity!.ino,
      identity!.mode,
    ])
  } finally {
    supported?.dispose()
    await server?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("TestClock waiting startup stops at an incompatible healthy generation", async () => {
  const root = await mkdtemp("/tmp/music-session-startup-waiting-incompatible-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  const foreign = await acquireStartupMarkerLease(runtime)
  if (foreign.type !== "acquired") throw new Error("foreign marker contention")
  const firstWait = Latch.makeUnsafe()
  const provider = createFakeProvider()
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let supported:
    Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  let identity:
    | { readonly dev: number; readonly ino: number; readonly mode: number }
    | undefined
  let launches = 0
  let probes = 0
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const clock = yield* TestClock.make()
          const workflow = connectOrStartMusicSessionEffect(
            {
              runtime,
              clientId: "incompatible-waiting",
              hostKind: "test",
              protocolRange: { major: 1, minRevision: 9, maxRevision: 10 },
              startup: { attempts: 4, initialDelayMs: 10, maxDelayMs: 20 },
              launcher: async () => {
                launches++
              },
            },
            {
              discover: async (options) => {
                probes++
                const found = await discoverMusicSession(options)
                if (found.type === "starting") Latch.openUnsafe(firstWait)
                return found
              },
            },
          )
          const fiber = yield* workflow.pipe(
            Effect.provideService(Clock.Clock, clock),
            Random.withSeed("waiting-incompatible"),
            Effect.forkScoped,
          )
          yield* Latch.await(firstWait)
          server = yield* Effect.promise(() =>
            startMusicSessionServer({ runtime }, provider),
          )
          supported = yield* Effect.promise(() =>
            createMusicSessionClient({
              socketPath: runtime.socketPath,
              clientId: "supported-during-waiting-incompatible",
              hostKind: "test",
            }),
          )
          identity = yield* Effect.promise(() => lstat(runtime.socketPath))
          // The initial jittered 10 ms delay is at most 12 ms, so this wakes
          // precisely one retry and its incompatible hello.
          yield* clock.adjust("20 millis")
          yield* Fiber.join(fiber).pipe(
            Effect.match({
              onFailure: (error) =>
                Effect.sync(() =>
                  expect(error).toMatchObject({
                    code: "INCOMPATIBLE_PROTOCOL",
                    details: {
                      client: { minRevision: 9, maxRevision: 10 },
                      daemon: { minRevision: 0, maxRevision: 1 },
                    },
                  }),
                ),
              onSuccess: () => Effect.die("expected incompatibility"),
            }),
          )
          expect(probes).toBe(2)
          yield* clock.adjust("1 hour")
          expect(probes).toBe(2)
        }),
      ),
    )
    expect(launches).toBe(0)
    expect((await lstat(runtime.markerPath)).isFile()).toBe(true)
    expect(await supported!.play()).toEqual({ action: "play" })
    const after = await lstat(runtime.socketPath)
    expect([after.dev, after.ino, after.mode]).toEqual([
      identity!.dev,
      identity!.ino,
      identity!.mode,
    ])
  } finally {
    supported?.dispose()
    await server?.close().catch(() => {})
    await foreign.lease.release().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("incompatible managed startup is terminal before marker acquisition", async () => {
  const root = await mkdtemp("/tmp/music-session-startup-incompatible-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  const provider = createFakeProvider()
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let supported:
    Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  let acquisitions = 0
  let launches = 0
  let attempts = 0
  try {
    server = await startMusicSessionServer({ runtime }, provider)
    supported = await createMusicSessionClient({
      socketPath: runtime.socketPath,
      clientId: "supported-during-incompatible",
      hostKind: "test",
    })
    const before = await lstat(runtime.socketPath)
    await expect(
      Effect.runPromise(
        connectOrStartMusicSessionEffect(
          {
            runtime,
            clientId: "incompatible",
            hostKind: "test",
            protocolRange: { major: 1, minRevision: 9, maxRevision: 10 },
            launcher: async () => {
              launches++
            },
          },
          {
            acquireLease: async (paths) => {
              acquisitions++
              return acquireStartupMarkerLease(paths)
            },
            onAttempt: () => attempts++,
            onReleaseFailure: () => {
              throw new Error("observer must not alter startup")
            },
          },
        ),
      ),
    ).rejects.toMatchObject({
      code: "INCOMPATIBLE_PROTOCOL",
      details: {
        client: { minRevision: 9, maxRevision: 10 },
        daemon: { minRevision: 0, maxRevision: 1 },
      },
    })
    expect(attempts).toBe(1)
    expect(acquisitions).toBe(0)
    expect(launches).toBe(0)
    expect(existsSync(runtime.markerPath)).toBe(false)
    const after = await lstat(runtime.socketPath)
    expect([after.dev, after.ino, after.mode]).toEqual([
      before.dev,
      before.ino,
      before.mode,
    ])
    expect(await supported.play()).toEqual({ action: "play" })
  } finally {
    supported?.dispose()
    await server?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("managed marker EPERM process checks stay conservative through the seam", async () => {
  const root = await mkdtemp("/tmp/music-session-runtime-marker-")
  try {
    const uid = process.getuid?.() ?? -1
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid,
      dependencies: {
        processExists: () => {
          throw Object.assign(new Error("operation not permitted"), {
            code: "EPERM",
          })
        },
      },
    })
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    await writeFile(
      runtime.markerPath,
      JSON.stringify({ version: 1, uid, pid: 1, attemptToken: "attempt" }),
      { mode: 0o600 },
    )
    const found = await discoverMusicSession({
      runtime,
      clientId: "marker",
      hostKind: "test",
    })
    expect(found.type).toBe("starting")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("invalid managed markers fail closed and remain untouched", async () => {
  for (const kind of [
    "malformed",
    "oversized",
    "uid-mismatch",
    "wrong-mode",
    "symlink",
    "directory",
  ] as const) {
    const root = await mkdtemp(`/tmp/music-session-marker-${kind}-`)
    try {
      const uid = process.getuid?.() ?? -1
      const runtime = resolveMusicSessionRuntimePaths({ root, uid })
      await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
      if (kind === "directory") await mkdir(runtime.markerPath, { mode: 0o600 })
      else if (kind === "symlink") {
        const target = `${root}/marker-target`
        await writeFile(target, "marker")
        await symlink(target, runtime.markerPath)
      } else {
        await writeFile(
          runtime.markerPath,
          kind === "malformed"
            ? "not json"
            : kind === "oversized"
              ? "x".repeat(4097)
              : JSON.stringify({
                  version: 1,
                  uid: kind === "uid-mismatch" ? uid + 1 : uid,
                  pid: process.pid,
                  attemptToken: "mode",
                }),
        )
        await chmod(runtime.markerPath, kind === "wrong-mode" ? 0o644 : 0o600)
      }
      await expect(
        discoverMusicSession({ runtime, clientId: kind, hostKind: "test" }),
      ).rejects.toBeInstanceOf(MusicSessionRuntimeError)
      const artifact = await lstat(runtime.markerPath)
      expect(kind === "symlink" ? artifact.isSymbolicLink() : true).toBe(true)
      expect(kind === "directory" ? artifact.isDirectory() : true).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("dead managed marker grants guarded idempotent cleanup", async () => {
  const root = await mkdtemp("/tmp/music-session-dead-marker-")
  try {
    const uid = process.getuid?.() ?? -1
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid,
      dependencies: {
        processExists: () => {
          throw Object.assign(new Error("no such process"), { code: "ESRCH" })
        },
      },
    })
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    await writeFile(
      runtime.markerPath,
      JSON.stringify({ version: 1, uid, pid: 123, attemptToken: "dead" }),
    )
    await chmod(runtime.markerPath, 0o600)
    const found = await discoverMusicSession({
      runtime,
      clientId: "dead-marker",
      hostKind: "test",
    })
    expect(found.type).toBe("stale")
    if (found.type === "stale") {
      await found.cleanup()
      await found.cleanup()
    }
    await expect(lstat(runtime.markerPath)).rejects.toMatchObject({
      code: "ENOENT",
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("unknown marker process errors remain starting without cleanup", async () => {
  const root = await mkdtemp("/tmp/music-session-unknown-marker-")
  try {
    const uid = process.getuid?.() ?? -1
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid,
      dependencies: {
        processExists: () => {
          throw Object.assign(new Error("unknown process failure"), {
            code: "EIO",
          })
        },
      },
    })
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    await writeFile(
      runtime.markerPath,
      JSON.stringify({ version: 1, uid, pid: 123, attemptToken: "unknown" }),
    )
    await chmod(runtime.markerPath, 0o600)
    const found = await discoverMusicSession({
      runtime,
      clientId: "unknown-marker",
      hostKind: "test",
    })
    expect(found.type).toBe("starting")
    expect("cleanup" in found).toBe(false)
    expect((await lstat(runtime.markerPath)).isFile()).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function leaveStaleSocket(
  runtime: ReturnType<typeof resolveMusicSessionRuntimePaths>,
) {
  const boundPath = `${runtime.directory}/b.sock`
  const server = net.createServer()
  let listening = false
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(boundPath, () => {
        listening = true
        resolve()
      })
    })
    await chmod(boundPath, 0o600)
    await rename(boundPath, runtime.socketPath)
    await new Promise<void>((resolve, reject) =>
      server.close((cause) => (cause ? reject(cause) : resolve())),
    )
    listening = false
  } finally {
    if (listening)
      await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test("refused socket disappearance after the connection attempt is missing without cleanup authority", async () => {
  const root = await mkdtemp("/tmp/music-session-disappeared-")
  try {
    const uid = process.getuid?.() ?? -1
    const base = resolveMusicSessionRuntimePaths({ root, uid })
    await Effect.runPromise(prepareManagedRuntimeDirectory(base))
    await leaveStaleSocket(base)
    let socketStats = 0
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid,
      dependencies: {
        lstat: (async (path) => {
          if (path === base.socketPath && ++socketStats > 1)
            throw Object.assign(new Error("gone"), { code: "ENOENT" })
          return lstat(path)
        }) as typeof lstat,
      },
    })
    const found = await discoverMusicSession({
      runtime,
      clientId: "disappeared",
      hostKind: "test",
    })
    expect(found.type).toBe("missing")
    expect("cleanup" in found).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("refused managed socket yields guarded idempotent stale cleanup", async () => {
  const root = await mkdtemp("/tmp/music-session-stale-")
  try {
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid: process.getuid?.() ?? -1,
    })
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    await leaveStaleSocket(runtime)
    const discovered = await discoverMusicSession({
      runtime,
      clientId: "stale",
      hostKind: "test",
    })
    expect(discovered.type).toBe("stale")
    if (discovered.type === "stale") {
      await discovered.cleanup()
      await discovered.cleanup()
    }
    await expect(lstat(runtime.socketPath)).rejects.toMatchObject({
      code: "ENOENT",
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("stale cleanup refuses a replacement artifact", async () => {
  const root = await mkdtemp("/tmp/music-session-stale-replacement-")
  try {
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid: process.getuid?.() ?? -1,
    })
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    await leaveStaleSocket(runtime)
    const discovered = await discoverMusicSession({
      runtime,
      clientId: "replacement",
      hostKind: "test",
    })
    expect(discovered.type).toBe("stale")
    await rm(runtime.socketPath, { force: true })
    await writeFile(runtime.socketPath, "replacement", { mode: 0o600 })
    if (discovered.type === "stale")
      await expect(discovered.cleanup()).rejects.toBeInstanceOf(
        MusicSessionRuntimeError,
      )
    expect((await lstat(runtime.socketPath)).isFile()).toBe(true)
    await rm(runtime.socketPath)
    await symlink(`${root}/target`, runtime.socketPath)
    if (discovered.type === "stale")
      await expect(discovered.cleanup()).rejects.toBeInstanceOf(
        MusicSessionRuntimeError,
      )
    expect((await lstat(runtime.socketPath)).isSymbolicLink()).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("simulated foreign socket and marker ownership fail closed without cleanup", async () => {
  for (const artifact of ["socket", "marker"] as const) {
    const root = await mkdtemp(`/tmp/music-session-foreign-${artifact}-`)
    try {
      const uid = process.getuid?.() ?? -1
      const base = resolveMusicSessionRuntimePaths({ root, uid })
      await Effect.runPromise(prepareManagedRuntimeDirectory(base))
      if (artifact === "socket") await leaveStaleSocket(base)
      else {
        await writeFile(
          base.markerPath,
          JSON.stringify({
            version: 1,
            uid,
            pid: 123,
            attemptToken: "foreign",
          }),
          { mode: 0o600 },
        )
      }
      let unlinks = 0
      const runtime = resolveMusicSessionRuntimePaths({
        root,
        uid,
        dependencies: {
          lstat: (async (path) => {
            const stat = await lstat(path)
            return path ===
              (artifact === "socket" ? base.socketPath : base.markerPath)
              ? new Proxy(stat, {
                  get(target, property, receiver) {
                    return property === "uid"
                      ? uid + 1
                      : Reflect.get(target, property, receiver)
                  },
                })
              : stat
          }) as typeof lstat,
          unlink: async (path) => {
            unlinks++
            return rm(path)
          },
        },
      })
      const path = artifact === "socket" ? base.socketPath : base.markerPath
      const before = await lstat(path)
      await expect(
        discoverMusicSession({ runtime, clientId: artifact, hostKind: "test" }),
      ).rejects.toBeInstanceOf(MusicSessionRuntimeError)
      const after = await lstat(path)
      expect(after.ino).toBe(before.ino)
      expect(after.mode).toBe(before.mode)
      expect(unlinks).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("malformed and reset managed peers stay occupied without cleanup", async () => {
  for (const mode of ["malformed", "reset"] as const) {
    const root = await mkdtemp(`/tmp/music-session-${mode}-peer-`)
    let server: net.Server | undefined
    try {
      const runtime = resolveMusicSessionRuntimePaths({
        root,
        uid: process.getuid?.() ?? -1,
      })
      await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
      let closed: Promise<void> | undefined
      server = net.createServer((socket) => {
        closed = new Promise<void>((resolve) => socket.once("close", resolve))
        if (mode === "malformed") socket.end("not json\\n")
        else socket.destroy()
      })
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject)
        server!.listen(runtime.socketPath, resolve)
      })
      await chmod(runtime.socketPath, 0o600)
      const found = await discoverMusicSession({
        runtime,
        clientId: mode,
        hostKind: "test",
      })
      expect(found.type).toBe("occupied")
      expect("cleanup" in found).toBe(false)
      await closed
      expect((await lstat(runtime.socketPath)).isSocket()).toBe(true)
    } finally {
      await new Promise<void>(
        (resolve) => server?.close(() => resolve()) ?? resolve(),
      )
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("a retryable reset with a live startup marker remains starting", async () => {
  const root = await mkdtemp("/tmp/music-session-marker-reset-")
  let server: net.Server | undefined
  try {
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid: process.getuid?.() ?? -1,
    })
    const acquired = await acquireStartupMarkerLease(runtime)
    if (acquired.type !== "acquired") throw new Error("expected marker lease")
    server = net.createServer((socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject)
      server!.listen(runtime.socketPath, resolve)
    })
    await chmod(runtime.socketPath, 0o600)
    const found = await discoverMusicSession({
      runtime,
      clientId: "marker-reset",
      hostKind: "test",
    })
    expect(found.type).toBe("starting")
    expect("cleanup" in found).toBe(false)
    expect((await lstat(runtime.socketPath)).isSocket()).toBe(true)
    await acquired.lease.release()
  } finally {
    await new Promise<void>(
      (resolve) => server?.close(() => resolve()) ?? resolve(),
    )
    await rm(root, { recursive: true, force: true })
  }
})

test("terminal reset and malformed peers do not borrow live-marker authority", async () => {
  for (const mode of ["no-marker", "dead-marker", "malformed"] as const) {
    const root = await mkdtemp(`/tmp/music-session-terminal-${mode}-`)
    let server: net.Server | undefined
    try {
      const uid = process.getuid?.() ?? -1
      const runtime = resolveMusicSessionRuntimePaths({
        root,
        uid,
        ...(mode === "dead-marker"
          ? {
              dependencies: {
                processExists: () => {
                  throw Object.assign(new Error("gone"), { code: "ESRCH" })
                },
              },
            }
          : {}),
      })
      await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
      if (mode !== "no-marker") {
        await writeFile(
          runtime.markerPath,
          JSON.stringify({
            version: 1,
            uid,
            pid: mode === "dead-marker" ? 123 : process.pid,
            attemptToken: mode,
          }),
          { mode: 0o600 },
        )
        await chmod(runtime.markerPath, 0o600)
      }
      server = net.createServer((socket) => {
        if (mode === "malformed") socket.end("not json\n")
        else socket.destroy()
      })
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject)
        server!.listen(runtime.socketPath, resolve)
      })
      await chmod(runtime.socketPath, 0o600)
      const socket = await lstat(runtime.socketPath)
      const marker =
        mode === "no-marker" ? undefined : await lstat(runtime.markerPath)
      const found = await discoverMusicSession({
        runtime,
        clientId: `terminal-${mode}`,
        hostKind: "test",
      })
      expect(found).toEqual({ type: "occupied" })
      const afterSocket = await lstat(runtime.socketPath)
      expect([afterSocket.dev, afterSocket.ino]).toEqual([
        socket.dev,
        socket.ino,
      ])
      if (marker) {
        const afterMarker = await lstat(runtime.markerPath)
        expect([afterMarker.dev, afterMarker.ino]).toEqual([
          marker.dev,
          marker.ino,
        ])
      }
    } finally {
      await new Promise<void>(
        (resolve) => server?.close(() => resolve()) ?? resolve(),
      )
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("reset classification fails closed when endpoint or marker changes during inspection", async () => {
  for (const artifact of ["endpoint", "marker"] as const) {
    const root = await mkdtemp(`/tmp/music-session-reset-replaced-${artifact}-`)
    let server: net.Server | undefined
    try {
      const uid = process.getuid?.() ?? -1
      const base = resolveMusicSessionRuntimePaths({ root, uid })
      await Effect.runPromise(prepareManagedRuntimeDirectory(base))
      await writeFile(
        base.markerPath,
        JSON.stringify({
          version: 1,
          uid,
          pid: process.pid,
          attemptToken: "original",
        }),
        { mode: 0o600 },
      )
      await chmod(base.markerPath, 0o600)
      let replaced = false
      let markerReads = 0
      const runtime = resolveMusicSessionRuntimePaths({
        root,
        uid,
        dependencies: {
          readFile: (async (path) => {
            const contents = await readFile(path, "utf8")
            if (path === base.markerPath && ++markerReads === 2) {
              replaced = true
              if (artifact === "endpoint") {
                await new Promise<void>((resolve) =>
                  server?.close(() => resolve()),
                )
                await leaveStaleSocket(base)
              } else {
                await rm(base.markerPath)
                await writeFile(
                  base.markerPath,
                  JSON.stringify({
                    version: 1,
                    uid,
                    pid: process.pid,
                    attemptToken: "replacement",
                  }),
                  { mode: 0o600 },
                )
                await chmod(base.markerPath, 0o600)
              }
            }
            return contents
          }) as typeof readFile,
        },
      })
      server = net.createServer((socket) => socket.destroy())
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject)
        server!.listen(base.socketPath, resolve)
      })
      await chmod(base.socketPath, 0o600)
      // Hold original inodes open so replacement cannot recycle them on Linux.
      // Fail-closed classification keys off identity change, not path reuse.
      const heldSocket = await open(base.socketPath, "r").catch(() => undefined)
      const heldMarker = await open(base.markerPath, "r")
      try {
        const found = await discoverMusicSession({
          runtime,
          clientId: `reset-replaced-${artifact}`,
          hostKind: "test",
        })
        // Why: a reset is waitable only for the exact pre-hello generation. If
        // the endpoint or marker is replaced mid-inspection, fail closed as
        // occupied so a foreign peer never inherits waiting authority.
        expect(found).toEqual({ type: "occupied" })
        expect(replaced).toBe(true)
        if (artifact === "marker") {
          expect(await readFile(base.markerPath, "utf8")).toContain(
            "replacement",
          )
          expect(await readFile(base.markerPath, "utf8")).not.toContain(
            '"attemptToken":"original"',
          )
        } else {
          // Endpoint was swapped for a stale unbound socket path; original
          // live listener is gone.
          expect(existsSync(base.socketPath)).toBe(true)
        }
      } finally {
        await heldSocket?.close().catch(() => {})
        await heldMarker.close().catch(() => {})
      }
    } finally {
      await new Promise<void>(
        (resolve) => server?.close(() => resolve()) ?? resolve(),
      )
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("reset classification rejects an in-place marker generation rewrite", async () => {
  const root = await mkdtemp("/tmp/music-session-reset-marker-rewrite-")
  let server: net.Server | undefined
  try {
    const uid = process.getuid?.() ?? -1
    const base = resolveMusicSessionRuntimePaths({ root, uid })
    await Effect.runPromise(prepareManagedRuntimeDirectory(base))
    await writeFile(
      base.markerPath,
      JSON.stringify({
        version: 1,
        uid,
        pid: process.pid,
        attemptToken: "original",
      }),
      { mode: 0o600 },
    )
    await chmod(base.markerPath, 0o600)
    let markerReads = 0
    const runtime = resolveMusicSessionRuntimePaths({
      root,
      uid,
      dependencies: {
        readFile: (async (path) => {
          const contents = await readFile(path, "utf8")
          if (path === base.markerPath && ++markerReads === 2) {
            await writeFile(
              base.markerPath,
              JSON.stringify({
                version: 1,
                uid,
                pid: process.pid,
                attemptToken: "rewritten-in-place",
              }),
              "utf8",
            )
            await chmod(base.markerPath, 0o600)
          }
          return contents
        }) as typeof readFile,
      },
    })
    server = net.createServer((socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject)
      server!.listen(base.socketPath, resolve)
    })
    await chmod(base.socketPath, 0o600)
    const socket = await lstat(base.socketPath)
    const marker = await lstat(base.markerPath)
    const found = await discoverMusicSession({
      runtime,
      clientId: "reset-marker-rewrite",
      hostKind: "test",
    })
    expect(found).toEqual({ type: "occupied" })
    const afterSocket = await lstat(base.socketPath)
    const afterMarker = await lstat(base.markerPath)
    expect([afterSocket.dev, afterSocket.ino]).toEqual([socket.dev, socket.ino])
    expect([afterMarker.dev, afterMarker.ino]).toEqual([marker.dev, marker.ino])
    expect(await readFile(base.markerPath, "utf8")).toContain(
      "rewritten-in-place",
    )
  } finally {
    await new Promise<void>(
      (resolve) => server?.close(() => resolve()) ?? resolve(),
    )
    await rm(root, { recursive: true, force: true })
  }
})

test("managed discovery returns a handshaken healthy client", async () => {
  const root = await mkdtemp("/tmp/music-session-discovery-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let discovered: Awaited<ReturnType<typeof discoverMusicSession>> | undefined
  try {
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    server = await startMusicSessionServer(
      { socketPath: runtime.socketPath },
      createFakeProvider(),
    )
    discovered = await discoverMusicSession({
      runtime,
      clientId: "discovery",
      hostKind: "test",
    })
    expect(discovered.type).toBe("healthy")
    if (discovered.type === "healthy") {
      expect(discovered.client.daemonInstanceId).not.toBe("")
      discovered.client.dispose()
    }
  } finally {
    if (discovered?.type === "healthy") discovered.client.dispose()
    await server?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("managed discovery preserves a live incompatible daemon generation", async () => {
  const root = await mkdtemp("/tmp/music-session-incompatible-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let healthy: Awaited<ReturnType<typeof discoverMusicSession>> | undefined
  try {
    server = await startMusicSessionServer({ runtime }, createFakeProvider())
    const before = await lstat(runtime.socketPath)
    const incompatible = await discoverMusicSession({
      runtime,
      clientId: "future",
      hostKind: "test",
      protocolRange: { major: 1, minRevision: 9, maxRevision: 10 },
    })
    expect(incompatible.type).toBe("incompatible")
    if (incompatible.type === "incompatible") {
      expect(incompatible.error.details).toMatchObject({
        client: { minRevision: 9, maxRevision: 10 },
        daemon: { minRevision: 0, maxRevision: 1 },
      })
      expect("cleanup" in incompatible).toBe(false)
    }
    const after = await lstat(runtime.socketPath)
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino])
    healthy = await discoverMusicSession({
      runtime,
      clientId: "supported",
      hostKind: "test",
    })
    expect(healthy.type).toBe("healthy")
  } finally {
    if (healthy?.type === "healthy") healthy.client.dispose()
    await server?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("healthy discovery grants cleanup only for a separately proven dead marker", async () => {
  const root = await mkdtemp("/tmp/music-session-healthy-dead-marker-")
  const uid = process.getuid?.() ?? -1
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid,
    dependencies: {
      processExists: () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" })
      },
    },
  })
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let discovered: Awaited<ReturnType<typeof discoverMusicSession>> | undefined
  try {
    server = await startMusicSessionServer({ runtime }, createFakeProvider())
    await writeFile(
      runtime.markerPath,
      JSON.stringify({ version: 1, uid, pid: 123, attemptToken: "dead" }),
      { mode: 0o600 },
    )
    await chmod(runtime.markerPath, 0o600)
    const socket = await lstat(runtime.socketPath)
    discovered = await discoverMusicSession({
      runtime,
      clientId: "dead-marker-healthy",
      hostKind: "test",
    })
    expect(discovered.type).toBe("healthy")
    if (discovered?.type === "healthy") await discovered.cleanup?.()
    await expect(lstat(runtime.markerPath)).rejects.toMatchObject({
      code: "ENOENT",
    })
    const after = await lstat(runtime.socketPath)
    expect([after.dev, after.ino]).toEqual([socket.dev, socket.ino])
  } finally {
    if (discovered?.type === "healthy") discovered.client.dispose()
    await server?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("healthy discovery wins over an untrusted startup marker", async () => {
  const root = await mkdtemp("/tmp/music-session-marker-precedence-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
  let discovered: Awaited<ReturnType<typeof discoverMusicSession>> | undefined
  try {
    server = await startMusicSessionServer({ runtime }, createFakeProvider())
    await writeFile(runtime.markerPath, "not marker json")
    discovered = await discoverMusicSession({
      runtime,
      clientId: "marker-precedence",
      hostKind: "test",
    })
    expect(discovered.type).toBe("healthy")
  } finally {
    if (discovered?.type === "healthy") discovered.client.dispose()
    await server?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("a valid live startup marker is starting and grants no cleanup", async () => {
  const root = await mkdtemp("/tmp/music-session-live-marker-")
  const runtime = resolveMusicSessionRuntimePaths({
    root,
    uid: process.getuid?.() ?? -1,
  })
  try {
    await Effect.runPromise(prepareManagedRuntimeDirectory(runtime))
    await writeFile(
      runtime.markerPath,
      JSON.stringify({
        version: 1,
        uid: runtime.uid,
        pid: process.pid,
        attemptToken: "live-attempt",
      }),
    )
    await chmod(runtime.markerPath, 0o600)
    await expect(
      discoverMusicSession({
        runtime,
        clientId: "live-marker",
        hostKind: "test",
      }),
    ).resolves.toEqual({ type: "starting" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a live marker cannot mask unsafe socket type or ownership", async () => {
  for (const kind of [
    "file",
    "symlink",
    "directory",
    "foreign-socket",
  ] as const) {
    const root = await mkdtemp(`/tmp/music-session-live-marker-${kind}-`)
    let acquired:
      Awaited<ReturnType<typeof acquireStartupMarkerLease>> | undefined
    try {
      const uid = process.getuid?.() ?? -1
      const base = resolveMusicSessionRuntimePaths({ root, uid })
      let unlinks = 0
      const runtime = resolveMusicSessionRuntimePaths({
        root,
        uid,
        dependencies: {
          lstat: (async (path) => {
            const stat = await lstat(path)
            return kind === "foreign-socket" && path === base.socketPath
              ? new Proxy(stat, {
                  get(target, property, receiver) {
                    return property === "uid"
                      ? uid + 1
                      : Reflect.get(target, property, receiver)
                  },
                })
              : stat
          }) as typeof lstat,
          unlink: async (path) => {
            unlinks++
            await rm(path)
          },
        },
      })
      acquired = await acquireStartupMarkerLease(runtime)
      if (acquired.type !== "acquired")
        throw new Error("live-marker setup lost lease contention")
      if (kind === "file")
        await writeFile(base.socketPath, "unexpected file", { mode: 0o600 })
      else if (kind === "symlink") {
        const target = `${root}/socket-target`
        await writeFile(target, "unexpected target", { mode: 0o600 })
        await symlink(target, base.socketPath)
      } else if (kind === "directory")
        await mkdir(base.socketPath, { mode: 0o700 })
      else await leaveStaleSocket(base)

      const socket = await lstat(base.socketPath)
      const marker = await lstat(base.markerPath)
      await expect(
        discoverMusicSession({ runtime, clientId: kind, hostKind: "test" }),
      ).rejects.toBeInstanceOf(MusicSessionRuntimeError)
      const afterSocket = await lstat(base.socketPath)
      const afterMarker = await lstat(base.markerPath)
      expect([afterSocket.dev, afterSocket.ino, afterSocket.mode]).toEqual([
        socket.dev,
        socket.ino,
        socket.mode,
      ])
      expect([afterMarker.dev, afterMarker.ino, afterMarker.mode]).toEqual([
        marker.dev,
        marker.ino,
        marker.mode,
      ])
      expect(unlinks).toBe(0)
    } finally {
      if (acquired?.type === "acquired")
        await acquired.lease.release().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  }
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

test("explicit client rejects invalid pending-request bounds before connecting", async () => {
  for (const maxPendingRequests of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    await expect(
      createMusicSessionClient({
        socketPath: `/tmp/music-session-invalid-pending-${process.pid}.sock`,
        clientId: "invalid-pending-bound",
        hostKind: "test",
        maxPendingRequests,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" })
})

test("explicit client bounds pending requests and recovers after settlement", async () => {
  const daemon = await startScriptedDaemon()
  let client: Awaited<ReturnType<typeof createMusicSessionClient>> | undefined
  try {
    client = await createMusicSessionClient({
      socketPath: daemon.path,
      clientId: "pending-bound",
      hostKind: "test",
      maxPendingRequests: 1,
    })
    const first = client.play()
    await daemon.received(2)
    await expect(client.pause()).rejects.toMatchObject({ code: "SERVER_BUSY" })
    expect(daemon.frames()).toHaveLength(2)
    daemon.send({
      type: "response",
      requestId: 1,
      ok: true,
      data: { action: "play" },
    })
    await expect(first).resolves.toEqual({ action: "play" })
    const second = client.pause()
    await daemon.received(3)
    daemon.send({
      type: "response",
      requestId: 2,
      ok: true,
      data: { action: "pause" },
    })
    await expect(second).resolves.toEqual({ action: "pause" })
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
    expect(client.negotiatedCapabilities).toEqual([
      "state-replay",
      "transport",
      "native-artwork",
    ])
  } finally {
    client?.dispose()
    await server?.close().catch(() => {})
  }
})
