import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createMusicPlayerPlugin } from "../index.tsx"
import plugin from "../index.tsx"
import { createSessionSystemMedia } from "../system-media.ts"

type SlotName = "session.composer.top" | "sidebar.content"
type Slot = (props: any) => any
type SlotClaim = { append: SlotName; render: Slot }

test("package entrypoint exports an OpenCode TUI plugin definition", () => {
  expect(plugin.id).toBe("music-player")
  expect(plugin.setup).toBeFunction()
})

test("production session adapter is shared by both slots and disposes only its client", async () => {
  let backendFactories = 0
  let clientFactories = 0
  let disposals = 0
  const slots = new Map<SlotName, Slot>()
  const client: any = {
    daemonInstanceId: "daemon",
    selectedRevision: 1,
    negotiatedCapabilities: ["state-replay", "transport", "native-artwork"],
    state: {
      daemonInstanceId: "daemon",
      revision: 1,
      state: {
        is_playing: false,
        progress_ms: 0,
        shuffle: false,
        repeat: "off",
        device: null,
        fetched_at: 1,
        track: null,
      },
    },
    status: {
      kind: "degraded",
      provider: "nowplaying-cli",
      message: "daemon fallback",
    },
    connection: { type: "connected", daemonInstanceId: "daemon" },
    subscribeState(listener: (value: any) => void) {
      listener(this.state)
      return () => {}
    },
    subscribeStatus(listener: (value: any) => void) {
      listener(this.status)
      return () => {}
    },
    subscribeConnection(listener: (value: any) => void) {
      listener(this.connection)
      return () => {}
    },
    async toggle() {
      return { action: "toggle" as const }
    },
    async play() {
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
      return { type: "unavailable" as const }
    },
    async dispose() {
      disposals++
    },
  }
  const context = {
    storage: {
      memory: () => {
        throw new Error("live playback state must not use host storage")
      },
    },
    ui: {
      toast: { show: () => {} },
      slot: (claim: SlotClaim) => {
        slots.set(claim.append, claim.render)
        return () => {}
      },
    },
    keymap: { layer: () => {} },
  }
  const testPlugin = createMusicPlayerPlugin({
    createSessionMedia: () => {
      backendFactories++
      return createSessionSystemMedia({
        createClient: async () => {
          clientFactories++
          return client
        },
      })
    },
  })

  const cleanup = await testPlugin.setup(context as any)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(backendFactories).toBe(1)
  expect(clientFactories).toBe(1)
  expect([...slots.keys()]).toEqual(["session.composer.top", "sidebar.content"])
  cleanup?.()
  await Promise.resolve()
  expect(disposals).toBe(1)
})

test("setup shares one session and persistent keymap across sidebar remounts", async () => {
  let constructed = 0
  let disposed = 0
  let unsubscriptions = 0
  let keymapLayers = 0
  const registered: string[] = []
  const slots = new Map<SlotName, Slot>()
  const sessionReads: Array<{ view: string; identity: object }> = []
  let mountedView = ""
  const session = new Proxy(
    {
      loading: false,
      error: null,
      player: {
        track: {
          uri: "shared",
          id: "shared",
          name: "Shared session track",
          artists: "Shared artist",
          album: "Shared album",
          duration_ms: 1000,
          artwork: null,
        },
        is_playing: true,
        progress_ms: 0,
        shuffle: false,
        repeat: "off" as const,
        device: null,
        fetched_at: Date.now(),
      },
    },
    {
      get(target, property, receiver) {
        if (property === "player") {
          sessionReads.push({ view: mountedView, identity: receiver })
        }
        return Reflect.get(target, property, receiver)
      },
    },
  )
  const sessionListeners = new Set<(state: typeof session) => void>()
  const controller = {
    session,
    subscribe(listener: (state: typeof session) => void) {
      sessionListeners.add(listener)
      listener(session)
      return () => sessionListeners.delete(listener)
    },
    openApp: async () => {},
    refreshAll: async () => {},
    playPause: async () => {},
    seek: async () => {},
    next: async () => {},
    prev: async () => {},
    dispose: () => {
      disposed++
    },
  }
  const context = {
    ui: {
      toast: { show: () => {} },
      slot: (claim: SlotClaim) => {
        registered.push(claim.append)
        slots.set(claim.append, claim.render)
        return () => {
          unsubscriptions++
        }
      },
    },
    keymap: {
      layer: () => {
        keymapLayers++
      },
    },
    theme: {
      text: {
        default: "white",
        subdued: "gray",
        action: { primary: { default: "blue" } },
        feedback: { error: { default: "red" } },
      },
      border: { default: "gray" },
      background: {
        surface: { offset: "black" },
        action: { primary: { default: "black" } },
      },
    },
  }
  const testPlugin = createMusicPlayerPlugin({
    createController: () => {
      constructed++
      return controller
    },
  })

  const cleanup = await testPlugin.setup(context as any)

  expect(constructed).toBe(1)
  expect(registered).toEqual(["session.composer.top", "sidebar.content"])

  mountedView = "app"
  const app = await testRender(
    () => slots.get("session.composer.top")!({ sessionID: "one" }),
    { width: 80, height: 4 },
  )
  await app.waitForFrame((frame) => frame.includes("Shared session track"))
  expect(keymapLayers).toBe(1)
  const replacement = {
    ...session,
    player: {
      ...session.player,
      track: { ...session.player.track, id: "async", name: "Async track" },
      is_playing: false,
    },
  }
  for (const listener of sessionListeners) listener(replacement)
  await app.waitForFrame((frame) => frame.includes("Async track"))

  mountedView = "sidebar-first"
  const firstSidebar = await testRender(
    () => slots.get("sidebar.content")!({ sessionID: "one" }),
    { width: 40, height: 24 },
  )
  firstSidebar.renderer.destroy()

  mountedView = "sidebar-second"
  const secondSidebar = await testRender(
    () => slots.get("sidebar.content")!({ sessionID: "one" }),
    { width: 40, height: 24 },
  )
  secondSidebar.renderer.destroy()

  for (const view of ["app", "sidebar-first", "sidebar-second"]) {
    expect(sessionReads.some((read) => read.view === view)).toBeTrue()
  }
  for (const read of sessionReads) expect(read.identity).toBe(session)
  expect(constructed).toBe(1)
  expect(keymapLayers).toBe(1)

  app.renderer.destroy()
  cleanup?.()
  expect(unsubscriptions).toBe(2)
  expect(disposed).toBe(1)
})
