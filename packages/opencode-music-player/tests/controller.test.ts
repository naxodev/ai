import { expect, test } from "bun:test"
import { createController } from "../index.tsx"
import { createSessionSystemMedia } from "../system-media.ts"
import type { PlayerState } from "../types.ts"
import { mkdtemp, rm } from "node:fs/promises"
import {
  createReconnectingMusicSessionClient,
  type ReconnectingMusicSessionClient,
  type ReconnectingMusicSessionClientOptions,
} from "../../music-core/session/client.ts"
import { resolveMusicSessionRuntimePaths } from "../../music-core/session/config.ts"
import { createFakeProvider } from "../../music-core/session/provider.ts"
import { startMusicSessionServer } from "../../music-core/session/server.ts"
import { createMusicDock } from "../../pi-music-dock/extensions/music-dock/index.ts"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}
const flush = () => Promise.resolve().then(() => Promise.resolve())

const player = (name: string, playing = false): PlayerState => ({
  is_playing: playing,
  progress_ms: 12_000,
  shuffle: false,
  repeat: "off",
  device: null,
  fetched_at: 42,
  track:
    name === "idle"
      ? null
      : {
          id: name,
          uri: `system:${name}`,
          name,
          artists: "Artist",
          album: "Album",
          duration_ms: 180_000,
          artwork: null,
        },
})

function createClient(initial = player("A")) {
  const stateListeners = new Set<(value: any) => void>()
  const statusListeners = new Set<(value: any) => void>()
  const connectionListeners = new Set<(value: any) => void>()
  const calls: string[] = []
  const client: any = {
    daemonInstanceId: "daemon-a",
    selectedRevision: 4,
    negotiatedCapabilities: ["state-replay", "transport", "native-artwork"],
    state: { daemonInstanceId: "daemon-a", revision: 4, state: initial },
    status: { kind: "ready", provider: "media", message: "ready" },
    connection: { type: "connected", daemonInstanceId: "daemon-a" },
    gate: undefined as Promise<void> | undefined,
    failure: undefined as Error | undefined,
    artworkResult: { type: "unavailable" as const },
    disposeCalls: 0,
    subscribeState(listener: (value: any) => void) {
      stateListeners.add(listener)
      listener(this.state)
      return () => stateListeners.delete(listener)
    },
    subscribeStatus(listener: (value: any) => void) {
      statusListeners.add(listener)
      listener(this.status)
      return () => statusListeners.delete(listener)
    },
    subscribeConnection(listener: (value: any) => void) {
      connectionListeners.add(listener)
      listener(this.connection)
      return () => connectionListeners.delete(listener)
    },
    emitState(
      this: any,
      next: PlayerState,
      revision = ++this.selectedRevision,
      daemonInstanceId = this.daemonInstanceId,
    ) {
      this.state = { daemonInstanceId, revision, state: next }
      this.daemonInstanceId = daemonInstanceId
      for (const listener of [...stateListeners]) listener(this.state)
    },
    emitStatus(next: any) {
      this.status = next
      for (const listener of [...statusListeners]) listener(next)
    },
    emitConnection(next: any) {
      this.connection = next
      for (const listener of [...connectionListeners]) listener(next)
    },
    toggle() {
      return this.command("toggle")
    },
    async command(name: string) {
      calls.push(name)
      await this.gate
      if (this.failure) throw this.failure
      return { action: name }
    },
    play() {
      return this.command("play")
    },
    pause() {
      return this.command("pause")
    },
    next() {
      return this.command("next")
    },
    previous() {
      return this.command("previous")
    },
    seek(position: number) {
      return this.command(`seek:${position}`)
    },
    async artwork() {
      return this.artworkResult
    },
    async dispose() {
      this.disposeCalls++
    },
  }
  return { client, calls, stateListeners, statusListeners, connectionListeners }
}

function harness(
  client: any,
  resolveArtworkDetails: any = async (_key: string, target: any) => ({
    artwork: null,
    duration_ms: target.duration_ms,
  }),
  now: () => number = Date.now,
) {
  const session = {
    loading: false,
    error: null as string | null,
    player: null as PlayerState | null,
  }
  const toasts: unknown[] = []
  const context = {
    storage: {
      memory: () => [
        session,
        (update: (draft: typeof session) => void) => update(session),
      ],
    },
    ui: { toast: { show: (toast: unknown) => toasts.push(toast) } },
  }
  const controller = createController(context as any, {
    createSessionMedia: () =>
      createSessionSystemMedia({
        createClient: async () => client,
        resolveArtworkDetails,
        now,
      }),
  })
  return { controller, session: controller.session, toasts }
}

test("production session controller receives replay/live/replacement state without host polling", async () => {
  const { client } = createClient(player("A", true))
  const view = harness(client)
  await flush()
  expect(view.session.player).toMatchObject({
    is_playing: true,
    progress_ms: 12_000,
    fetched_at: 42,
    track: { id: "A" },
  })

  client.emitState(player("paused"))
  client.emitState(player("idle"))
  client.emitConnection({
    type: "reconnecting",
    error: { message: "lost", retryable: true },
  })
  expect(view.session.player?.track).toBeNull()
  expect(view.session.error).toBe("lost")
  client.emitConnection({ type: "connected", daemonInstanceId: "daemon-b" })
  client.emitState(player("B", true), 1, "daemon-b")
  expect(view.session.player).toMatchObject({
    is_playing: true,
    track: { id: "B" },
  })
  view.controller.dispose()
})

test("commands delegate immediately, retain narrow latest seek, and preserve loading", async () => {
  const { client, calls } = createClient()
  const gate = deferred<void>()
  client.gate = gate.promise
  const view = harness(client)
  await flush()
  const play = view.controller.playPause()
  const next = view.controller.next()
  const firstSeek = view.controller.seek(10_000)
  const latestSeek = view.controller.seek(20_000)
  await flush()
  expect(calls).toEqual(["toggle", "next", "seek:10000"])
  expect(view.session.loading).toBeTrue()
  expect(view.session.player).toMatchObject({
    is_playing: false,
    progress_ms: 12_000,
    fetched_at: 42,
    track: { duration_ms: 180_000 },
  })
  gate.resolve()
  await Promise.all([play, next, firstSeek, latestSeek])
  expect(calls).toEqual(["toggle", "next", "seek:10000", "seek:20000"])
  expect(view.session.loading).toBeFalse()
  expect(view.session.player).toMatchObject({
    is_playing: false,
    progress_ms: 12_000,
    fetched_at: 42,
    track: { duration_ms: 180_000 },
  })

  client.emitState({
    ...player("A", true),
    progress_ms: 20_000,
    fetched_at: 84,
    track: { ...player("A", true).track!, duration_ms: 181_000 },
  })
  expect(view.session.player).toMatchObject({
    is_playing: true,
    progress_ms: 20_000,
    fetched_at: 84,
    track: { duration_ms: 181_000 },
  })
  view.controller.dispose()
})

test("session artwork completion merges through the controller without replacing playback", async () => {
  const { client } = createClient(player("artwork", true))
  client.artworkResult = { type: "available", base64: "cover" }
  const cover = { id: "cover", png_base64: "", accent: "", cells: [] }
  const view = harness(client, async (_key: string, target: any) => ({
    artwork: cover,
    duration_ms: target.duration_ms,
  }))
  await flush()
  await flush()
  await flush()
  await flush()
  expect(view.session.player?.is_playing).toBeTrue()
  expect(view.session.player?.progress_ms).toBe(12_000)
  expect(view.session.player?.track?.id).toBe("artwork")
  expect(view.session.player?.track?.artwork?.id).toBe(cover.id)
  expect(view.session.player?.track?.artwork_loading).toBeFalse()
  view.controller.dispose()
})

test.skipIf(process.platform === "win32")(
  "Pi and OpenCode adapters toggle one daemon despite stale views and rapid clicks",
  async () => {
    const provider = createFakeProvider(player("shared"))
    // The Unix socket limit requires a short temporary runtime path.
    const root = await mkdtemp("/tmp/music-toggle-")
    const runtime = resolveMusicSessionRuntimePaths({ root })
    let server: Awaited<ReturnType<typeof startMusicSessionServer>> | undefined
    const clients: ReconnectingMusicSessionClient[] = []
    const connect = (options: ReconnectingMusicSessionClientOptions) =>
      createReconnectingMusicSessionClient({
        ...options,
        runtime,
        launcher: async () => {
          throw new Error("Fixture daemon must already be running")
        },
      })
    const events: Record<string, (...args: any[]) => Promise<void>> = {}
    const commands: Record<
      string,
      { handler: (...args: any[]) => Promise<void> }
    > = {}
    const notifications: string[] = []
    const ctx = {
      mode: "tui",
      hasUI: true,
      ui: {
        setWidget() {},
        setStatus() {},
        theme: { fg: (_color: string, text: string) => text },
        notify: (text: string) => notifications.push(text),
      },
    }
    let view: ReturnType<typeof harness> | undefined
    const admitted = Array.from({ length: 5 }, () => deferred<void>())
    const releases = Array.from({ length: 3 }, () => deferred<void>())
    let admissionCount = 0
    try {
      server = await startMusicSessionServer({ runtime }, provider, {
        onCommandAdmission: () => admitted[admissionCount++]?.resolve(),
      })
      const oc = await connect({
        hostKind: "opencode",
        clientId: "toggle-opencode",
      })
      clients.push(oc)
      expect(oc.daemonInstanceId).toBe(server.coordinator.daemonInstanceId)
      // Delay OpenCode state delivery while real transport acknowledgements flow.
      const subscribe = oc.subscribeState.bind(oc)
      oc.subscribeState = (listener) => {
        let replayed = false
        return subscribe((snapshot) => {
          if (replayed) return
          replayed = true
          listener(snapshot)
        })
      }
      view = harness(oc)
      const installed = deferred<void>()
      createMusicDock(
        {
          registerShortcut() {},
          registerCommand: (name: string, command: any) => {
            commands[name] = command
          },
          on: (name: string, handler: any) => {
            events[name] = handler
          },
        } as never,
        {
          createClient: async (options) => {
            const client = await connect(options)
            clients.push(client)
            const subscribeConnection = client.subscribeConnection.bind(client)
            client.subscribeConnection = (listener) => {
              const dispose = subscribeConnection(listener)
              installed.resolve()
              return dispose
            }
            return client
          },
          fetch: async () => new Response(null, { status: 404 }),
        },
      )
      await events.session_start!({}, ctx)
      await installed.promise
      expect(clients[0]!.daemonInstanceId).toBe(clients[1]!.daemonInstanceId)
      expect(view.session.player?.track?.id).toBe("shared")
      expect(provider.counts.subscriptions).toBe(1)
      await commands.music!.handler("", ctx)
      expect(notifications).toEqual([])
      expect(provider.calls).toEqual(["play"])
      expect(provider.state.is_playing).toBeTrue()
      expect(view.session.player?.is_playing).toBeFalse()
      await view.controller.playPause()
      expect(provider.state.is_playing).toBeFalse()

      const started = Array.from({ length: 3 }, () => deferred<void>())
      let transportIndex = 0
      const transport = provider.transport.bind(provider)
      provider.transport = async (action, position) => {
        const index = transportIndex++
        started[index]!.resolve()
        await releases[index]!.promise
        if (index === 1) provider.failNextTransport()
        await transport(action, position)
      }
      const settlements: string[] = []
      const first = view.controller.playPause().then(() => {
        settlements.push("opencode-first")
      })
      await admitted[2]!.promise
      await started[0]!.promise
      const second = commands.music!.handler("", ctx).then(() => {
        settlements.push("pi")
      })
      await admitted[3]!.promise
      const third = view.controller.playPause().then(() => {
        settlements.push("opencode-third")
      })
      expect(view.session.loading).toBeTrue()
      expect(settlements).toEqual([])
      releases[0]!.resolve()
      await first
      expect(settlements).toEqual(["opencode-first"])
      expect(view.session.loading).toBeTrue()
      // Each socket processes requests serially; its next request enters after the first acknowledgement.
      await admitted[4]!.promise
      await started[1]!.promise
      releases[1]!.resolve()
      await second
      expect(settlements).toEqual(["opencode-first", "pi"])
      expect(notifications).toEqual(["provider transport failed"])
      expect(view.toasts).toEqual([])
      expect(view.session.loading).toBeTrue()
      expect(provider.state.is_playing).toBeTrue()
      await started[2]!.promise
      releases[2]!.resolve()
      await third
      expect(settlements).toEqual(["opencode-first", "pi", "opencode-third"])
      // The failed Pi toggle must not project pause before the final OpenCode toggle.
      expect(provider.calls).toEqual([
        "play",
        "pause",
        "play",
        "pause",
        "pause",
      ])
      expect(provider.state.is_playing).toBeFalse()
      expect(view.session.player?.is_playing).toBeFalse()
      expect(view.session.loading).toBeFalse()
      expect(view.toasts).toEqual([])
    } finally {
      for (const release of releases) release.resolve()
      const errors: unknown[] = []
      for (const cleanup of [
        () => events.session_shutdown?.({}, ctx),
        () => view?.controller.dispose(),
        ...clients.map((client) => () => client.dispose()),
        () => server?.close(),
        () => rm(root, { recursive: true, force: true }),
      ]) {
        try {
          await cleanup()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length)
        throw new AggregateError(errors, "Toggle fixture cleanup failed")
    }
  },
)

test("same-track polling does not reopen completed artwork", async () => {
  let now = 1_000
  const current = player("artwork-retry", true)
  const { client } = createClient(current)
  const view = harness(
    client,
    async (_key: string, target: any) => ({
      artwork: null,
      duration_ms: target.duration_ms,
    }),
    () => now,
  )
  for (let index = 0; index < 4; index++) await flush()
  expect(view.session.player?.track?.artwork_loading).toBeFalse()

  now = 3_001
  client.emitState({
    ...current,
    progress_ms: 15_000,
    fetched_at: now,
    track: { ...current.track!, id: "volatile-next" },
  })
  expect(view.session.player?.track?.artwork_loading).toBeFalse()
  expect(view.session.player?.track?.id).toBe("volatile-next")
  view.controller.dispose()
})

test("play and seek retain daemon state until the next snapshot", async () => {
  const { client } = createClient()
  const playGate = deferred<void>()
  client.gate = playGate.promise
  const view = harness(client)
  await flush()
  const playing = view.controller.playPause()
  await flush()
  expect(view.session.player).toMatchObject({
    is_playing: false,
    progress_ms: 12_000,
    fetched_at: 42,
  })
  client.emitState(player("daemon-paused", false))
  playGate.resolve()
  await playing
  expect(view.session.player).toMatchObject({
    is_playing: false,
    track: { id: "daemon-paused" },
  })

  const seekGate = deferred<void>()
  client.gate = seekGate.promise
  const seeking = view.controller.seek(90_000)
  await flush()
  expect(view.session.player).toMatchObject({
    progress_ms: 12_000,
    fetched_at: 42,
    track: { id: "daemon-paused", duration_ms: 180_000 },
  })
  client.emitState({ ...player("daemon-seek", false), progress_ms: 45_000 })
  seekGate.resolve()
  await seeking
  expect(view.session.player).toMatchObject({
    progress_ms: 45_000,
    track: { id: "daemon-seek" },
  })
  view.controller.dispose()
})

test("bar-edge seeks clamp just short of the track end instead of skipping songs", async () => {
  const { client, calls } = createClient()
  const view = harness(client)
  await flush()
  // Clicking the last cell maps to the exact duration; seeking there would
  // finish the track immediately and advance to the next song.
  await view.controller.seek(180_000)
  await view.controller.seek(500_000)
  expect(calls).toEqual(["seek:179000", "seek:179000"])
  view.controller.dispose()
})

test("very short tracks clamp end-of-bar seeks to the start rather than negative positions", async () => {
  const { client, calls } = createClient({
    ...player("short"),
    track: { ...player("short").track!, duration_ms: 400 },
  })
  const view = harness(client)
  await flush()
  await view.controller.seek(400)
  expect(calls).toEqual(["seek:0"])
  view.controller.dispose()
})

test("clicks remain toggles when command acknowledgement precedes state replay", async () => {
  const { client, calls } = createClient()
  const gate = deferred<void>()
  client.gate = gate.promise
  const view = harness(client)
  await flush()

  const play = view.controller.playPause()
  gate.resolve()
  await play
  const pause = view.controller.playPause()
  await pause

  expect(calls).toEqual(["toggle", "toggle"])
  expect(view.session.player?.is_playing).toBeFalse()
  view.controller.dispose()
})

test("replacement authority receives toggles without retained local intent", async () => {
  const { client, calls } = createClient()
  const view = harness(client)
  await flush()

  await view.controller.playPause()
  client.emitConnection({
    type: "reconnecting",
    error: { message: "lost", retryable: true },
  })
  client.emitState(player("replacement", false), 1, "daemon-b")
  await view.controller.playPause()

  expect(calls).toEqual(["toggle", "toggle"])
  view.controller.dispose()
})

test("coalesced seeks keep loading owned across the command handoff", async () => {
  const { client } = createClient()
  const gate = deferred<void>()
  client.gate = gate.promise
  const view = harness(client)
  await flush()
  const loading: boolean[] = []
  const unsubscribe = view.controller.subscribe((session) =>
    loading.push(session.loading),
  )

  const first = view.controller.seek(10_000)
  const latest = view.controller.seek(20_000)
  await flush()
  loading.length = 0
  gate.resolve()
  await Promise.all([first, latest])

  expect(loading.at(-1)).toBeFalse()
  expect(loading.slice(0, -1).every(Boolean)).toBeTrue()
  unsubscribe()
  view.controller.dispose()
})

test("lifecycle and transport errors do not erase one another or reconcile", async () => {
  const { client, calls } = createClient()
  const view = harness(client)
  await flush()
  client.emitStatus({
    kind: "degraded",
    provider: "fallback",
    message: "fallback",
  })
  expect(view.session.error).toBe("fallback")
  client.emitConnection({
    type: "reconnecting",
    error: { message: "reconnecting", retryable: true },
  })
  expect(view.session.error).toBe("reconnecting")
  client.failure = new Error(
    "command\u001b]52;c;YXR0YWNr\u0007\u001b[31m\nfailed",
  )
  await view.controller.next()
  expect(calls).toEqual(["next"])
  expect(view.session.error).toBe("reconnecting")
  expect(view.toasts).toHaveLength(1)
  expect(view.toasts[0]).toMatchObject({ message: "command failed" })
  client.emitConnection({ type: "connected", daemonInstanceId: "daemon-a" })
  expect(view.session.error).toBe("command failed")
  client.emitConnection({
    type: "terminal",
    error: { message: "incompatible" },
  })
  expect(view.session.error).toBe("incompatible")
  await view.controller.refreshAll()
  expect(view.session.error).toBe("incompatible")
  view.controller.dispose()
})

test("overlapping controls keep loading until every command settles", async () => {
  const { client, calls } = createClient()
  const next = deferred<void>()
  const previous = deferred<void>()
  client.next = () => {
    calls.push("next")
    return next.promise
  }
  client.previous = () => {
    calls.push("previous")
    return previous.promise
  }
  const view = harness(client)
  await flush()
  const nextCommand = view.controller.next()
  const previousCommand = view.controller.prev()
  expect(view.session.loading).toBeTrue()
  next.reject(new Error("next failed"))
  await flush()
  expect(view.session.loading).toBeTrue()
  expect(view.session.error).toBe("next failed")
  previous.resolve()
  await Promise.all([nextCommand, previousCommand])
  expect(calls).toEqual(["next", "previous"])
  expect(view.session.loading).toBeFalse()
  view.controller.dispose()
})

test("reconnect cancels an unissued latest seek without replaying it", async () => {
  const { client, calls } = createClient()
  const gate = deferred<void>()
  client.gate = gate.promise
  const view = harness(client)
  await flush()
  const active = view.controller.seek(10_000)
  const latest = view.controller.seek(20_000)
  await flush()
  expect(calls).toEqual(["seek:10000"])
  client.emitConnection({
    type: "reconnecting",
    error: { message: "lost", retryable: true },
  })
  await latest
  gate.resolve()
  await active
  expect(calls).toEqual(["seek:10000"])
  view.controller.dispose()
})

test("transport recovery restores retained provider lifecycle feedback", async () => {
  const { client } = createClient()
  const view = harness(client)
  await flush()

  client.emitStatus({
    kind: "degraded",
    provider: "fallback",
    message: "degraded",
  })
  client.failure = new Error("failed")
  await view.controller.next()
  expect(view.session.error).toBe("failed")
  client.failure = undefined
  await view.controller.next()
  expect(view.session.error).toBe("degraded")

  client.failure = new Error("failed again")
  await view.controller.next()
  client.emitStatus({
    kind: "unavailable",
    provider: "fallback",
    message: "unavailable",
  })
  expect(view.session.error).toBe("failed again")
  client.failure = undefined
  await view.controller.next()
  expect(view.session.error).toBe("unavailable")
  view.controller.dispose()
})

test("disposal settles callers and fences held command and late state", async () => {
  const { client, calls } = createClient()
  const gate = deferred<void>()
  client.gate = gate.promise
  const view = harness(client)
  await flush()
  const playing = view.controller.playPause()
  await flush()
  expect(view.session.loading).toBeTrue()
  const before = view.session.player
  view.controller.dispose()
  await playing
  client.emitState(player("late", true))
  gate.resolve()
  await flush()
  expect(calls).toEqual(["toggle"])
  expect(client.disposeCalls).toBe(1)
  expect(view.session.player).toBe(before)
  expect(view.session.loading).toBeFalse()
})
