import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createController } from "../index.tsx"
import { CompactPlayer, SidebarPlayer } from "../ui.tsx"

const player = (id: string) => ({
  track: {
    id,
    name: id,
    artists: "Artist",
    duration_ms: 1000,
    artwork: null,
  },
  is_playing: true,
  progress_ms: 0,
  fetched_at: Date.now(),
})

const theme = {
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
}

test("a completed poll leaves one timeout and view mounts schedule none", async () => {
  let reads = 0
  let nextTimer = 0
  const pending = new Map<number, () => void>()
  const cleared: number[] = []
  const session = { loading: false, error: null, player: null as any }
  const context = {
    storage: {
      memory: () => [
        session,
        (update: (state: typeof session) => void) => update(session),
      ],
    },
    ui: { toast: { show: () => {} } },
    theme,
  }
  const controller = createController(context as any, {
    createBackend: () =>
      ({
        player: async () => player(`read-${++reads}`),
      }) as any,
    scheduleTimeout: ((callback: () => void) => {
      const timer = ++nextTimer
      pending.set(timer, callback)
      return timer
    }) as any,
    clearScheduledTimeout: ((timer: number) => {
      cleared.push(timer)
      pending.delete(timer)
    }) as any,
    delay: async () => {},
  })

  await controller.refreshAll()
  expect(pending.size).toBe(1)
  const [timer, runPoll] = pending.entries().next().value!
  pending.delete(timer)
  runPoll()
  await Promise.resolve()
  await Promise.resolve()
  expect(reads).toBe(2)
  expect(pending.size).toBe(1)

  const compact = await testRender(
    () =>
      CompactPlayer({
        context: context as any,
        state: session,
        onPlayPause: () => {},
        onSeek: () => {},
      }),
    { width: 40, height: 4 },
  )
  const sidebar = await testRender(
    () =>
      SidebarPlayer({
        context: context as any,
        state: session,
        onPlayPause: () => {},
        onNext: () => {},
        onPrev: () => {},
        onSeek: () => {},
      }),
    { width: 40, height: 24 },
  )
  expect(pending.size).toBe(1)
  expect(nextTimer).toBe(2)

  compact.renderer.destroy()
  sidebar.renderer.destroy()
  controller.dispose()
  expect(cleared).toEqual([2])
  expect(pending.size).toBe(0)
})

test("disposal clears the sole poll and ignores an in-flight refresh", async () => {
  let resolvePlayer: ((value: unknown) => void) | undefined
  let reads = 0
  const scheduled: Array<() => void> = []
  const cleared: number[] = []
  const session = { loading: false, error: null, player: null as any }
  const context = {
    storage: {
      memory: () => [
        session,
        (update: (state: typeof session) => void) => update(session),
      ],
    },
    ui: { toast: { show: () => {} } },
  }

  const controller = createController(context as any, {
    createBackend: () =>
      ({
        player: () => {
          reads++
          return new Promise((resolve) => {
            resolvePlayer = resolve
          })
        },
      }) as any,
    scheduleTimeout: ((callback: () => void) => {
      scheduled.push(callback)
      return scheduled.length
    }) as any,
    clearScheduledTimeout: ((timer: number) => cleared.push(timer)) as any,
    delay: async () => {},
  })

  expect(reads).toBe(1)
  // No fallback poll competes with the provider sample already in flight.
  expect(scheduled).toHaveLength(0)
  controller.dispose()
  expect(cleared).toEqual([])

  resolvePlayer?.({
    track: { id: "late", name: "Late", artists: "Artist", duration_ms: 1 },
    is_playing: true,
    progress_ms: 0,
    fetched_at: Date.now(),
  })
  await Promise.resolve()
  await Promise.resolve()

  expect(session.player).toBeNull()
  expect(scheduled).toHaveLength(0)
})

test("disposal ignores an in-flight play command completion", async () => {
  let resolvePlay: (() => void) | undefined
  const session = {
    loading: false,
    error: null,
    player: player("paused"),
  }
  session.player.is_playing = false
  const context = {
    storage: {
      memory: () => [
        session,
        (update: (state: typeof session) => void) => update(session),
      ],
    },
    ui: { toast: { show: () => {} } },
  }
  const controller = createController(context as any, {
    createBackend: () =>
      ({
        player: async () => session.player,
        play: () =>
          new Promise<void>((resolve) => {
            resolvePlay = resolve
          }),
      }) as any,
    scheduleTimeout: (() => 1) as any,
    clearScheduledTimeout: (() => {}) as any,
    delay: async () => {},
  })
  await controller.refreshAll()
  const command = controller.playPause()

  controller.dispose()
  resolvePlay?.()
  await command

  expect(session.player.is_playing).toBe(false)
})
