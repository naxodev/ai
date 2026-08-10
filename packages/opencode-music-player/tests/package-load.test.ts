import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createMusicPlayerPlugin } from "../index.tsx"
import plugin from "../index.tsx"

type SlotName = "app" | "sidebar.content"
type Slot = (props: any) => any

test("package entrypoint exports an OpenCode TUI plugin definition", () => {
  expect(plugin.id).toBe("music-player")
  expect(plugin.setup).toBeFunction()
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
  const controller = {
    session,
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
      slot: (name: SlotName, render: Slot) => {
        registered.push(name)
        slots.set(name, render)
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
  expect(registered).toEqual(["app", "sidebar.content"])

  mountedView = "app"
  const app = await testRender(() => slots.get("app")!({}), {
    width: 80,
    height: 4,
  })
  await app.waitForFrame((frame) => frame.includes("Shared session track"))
  expect(keymapLayers).toBe(1)

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
