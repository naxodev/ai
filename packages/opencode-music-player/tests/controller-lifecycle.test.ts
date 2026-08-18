import { expect, test } from "bun:test"
import { createController } from "../index.tsx"
import { createSessionSystemMedia } from "../system-media.ts"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}
const flush = () => Promise.resolve().then(() => Promise.resolve())

function context() {
  const session = { loading: false, error: null, player: null as any }
  const toasts: unknown[] = []
  return {
    session,
    toasts,
    context: {
      storage: {
        memory: () => [
          session,
          (update: (draft: typeof session) => void) => update(session),
        ],
      },
      ui: { toast: { show: (toast: unknown) => toasts.push(toast) } },
    },
  }
}

function client(name: string) {
  const listeners = new Set<(state: any) => void>()
  const connectionListeners = new Set<(connection: any) => void>()
  const state = {
    daemonInstanceId: name,
    revision: 1,
    state: {
      is_playing: false,
      progress_ms: 0,
      shuffle: false,
      repeat: "off",
      device: null,
      fetched_at: 1,
      track: {
        id: name,
        uri: `system:${name}`,
        name,
        artists: "Artist",
        album: "Album",
        duration_ms: 180_000,
      },
    },
  }
  const value: any = {
    daemonInstanceId: name,
    selectedRevision: 1,
    negotiatedCapabilities: ["state-replay", "transport", "native-artwork"],
    state,
    status: { kind: "ready", provider: "media", message: "ready" },
    connection: { type: "connected", daemonInstanceId: name },
    disposals: 0,
    gate: undefined as Promise<void> | undefined,
    artworkGate: undefined as Promise<any> | undefined,
    subscribeState(listener: (event: any) => void) {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    subscribeStatus(listener: (event: any) => void) {
      listener(this.status)
      return () => {}
    },
    subscribeConnection(listener: (event: any) => void) {
      connectionListeners.add(listener)
      listener(this.connection)
      return () => connectionListeners.delete(listener)
    },
    emitConnection(next: any) {
      this.connection = next
      for (const listener of [...connectionListeners]) listener(next)
    },
    emit(next: any) {
      for (const listener of [...listeners]) listener(next)
    },
    async toggle() {
      return { action: "toggle" as const }
    },
    async play() {
      await this.gate
      return { action: "play" as const }
    },
    async pause() {
      return { action: "pause" as const }
    },
    async next() {
      return { action: "next" as const }
    },
    async previous() {
      return { action: "previous" as const }
    },
    async seek() {
      return { action: "seek" as const }
    },
    async artwork() {
      return this.artworkGate ?? { type: "unavailable" as const }
    },
    async dispose() {
      this.disposals++
    },
  }
  return { value, listeners }
}

test("disposal before factory resolution releases the client without callbacks", async () => {
  const late = deferred<any>()
  const { context: host, session } = context()
  const media = createSessionSystemMedia({ createClient: () => late.promise })
  const controller = createController(host as any, {
    createSessionMedia: () => media,
  })
  controller.dispose()
  const next = client("late").value
  late.resolve(next)
  await flush()
  expect(next.disposals).toBe(1)
  expect(session.player).toBeNull()
})

test("disposal settles held work once and leaves another session client healthy", async () => {
  const first = client("first")
  const second = client("second")
  const held = deferred<void>()
  const heldArtwork = deferred<any>()
  first.value.gate = held.promise
  first.value.artworkGate = heldArtwork.promise
  const firstHost = context()
  const secondHost = context()
  const create = (host: ReturnType<typeof context>, value: any) =>
    createController(host.context as any, {
      createSessionMedia: () =>
        createSessionSystemMedia({
          createClient: async () => value,
          resolveArtworkDetails: async (_key, target) => ({
            artwork: null,
            duration_ms: target.duration_ms,
          }),
        }),
    })
  const controllerA = create(firstHost, first.value)
  const controllerB = create(secondHost, second.value)
  await flush()
  const operation = controllerA.playPause()
  controllerA.dispose()
  controllerA.dispose()
  await operation
  held.resolve()
  heldArtwork.resolve({ type: "available", base64: "late" })
  first.value.emitConnection({
    type: "reconnecting",
    error: { message: "late", retryable: true },
  })
  const update = {
    ...second.value.state,
    revision: 2,
    state: { ...second.value.state.state, progress_ms: 99 },
  }
  second.value.emit(update)
  await flush()
  expect(first.value.disposals).toBe(1)
  expect(second.value.disposals).toBe(0)
  expect(secondHost.session.player?.progress_ms).toBe(99)
  expect(firstHost.toasts).toEqual([])
  controllerB.dispose()
  await flush()
  expect(second.value.disposals).toBe(1)
})
