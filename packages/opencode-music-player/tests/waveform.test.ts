import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createEngine, stepEngine, waveformSeedKey } from "@naxodev/music-core"
import { createWaveformCoordinator as createPiWaveformCoordinator } from "../../pi-music-dock/extensions/music-dock/waveform.ts"
import { createWaveformCoordinator } from "../waveform.tsx"
import type { PlayerState } from "../types.ts"

test("Solid adapter uses the provider sample wall-clock domain", () => {
  const source = readFileSync(join(import.meta.dir, "../waveform.tsx"), "utf8")
  expect(source).toContain("now: () => Date.now()")
  expect(source).not.toContain("performance.now()")
})

function player(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    is_playing: true,
    progress_ms: 1_000,
    shuffle: false,
    repeat: "off",
    device: null,
    track: {
      id: "track-a",
      uri: "track-a",
      name: "Track A",
      artists: "Artist",
      album: "Album",
      duration_ms: 180_000,
      artwork: null,
    },
    fetched_at: 10_000,
    ...overrides,
  }
}

function fakeScheduler() {
  let next = 0
  const callbacks = new Map<number, () => void>()
  const created: number[] = []
  const cleared: number[] = []
  return {
    created,
    cleared,
    setInterval(callback: () => void) {
      const id = next++
      created.push(id)
      callbacks.set(id, callback)
      return id
    },
    clearInterval(id: unknown) {
      cleared.push(id as number)
      callbacks.delete(id as number)
    },
    run() {
      for (const callback of [...callbacks.values()]) callback()
    },
  }
}

function setup() {
  let now = 10_000
  const scheduler = fakeScheduler()
  const frames: Array<{
    key: string
    phase: number
    correction: number
    stable: boolean
    levels: number[]
  }> = []
  let clears = 0
  const coordinator = createWaveformCoordinator({
    now: () => now,
    scheduler,
    intervalMs: 48,
    render: (_player, engine) =>
      frames.push({
        key: engine.track_key,
        phase: engine.phase_ms,
        correction: engine.correction_ms,
        stable: engine.paused_stable,
        levels: [...engine.levels],
      }),
    clear: () => clears++,
  })
  const key = waveformSeedKey("Track A", "track-a")
  return {
    scheduler,
    frames,
    clears: () => clears,
    coordinator,
    key,
    now: () => now,
    setNow: (next: number) => (now = next),
  }
}

describe("OpenCode waveform lifecycle", () => {
  test("clears the previous waveform when playback has no track", () => {
    const host = setup()
    host.coordinator.setInput(player(), host.key, 24)
    host.coordinator.frame()

    host.coordinator.setInput(null, "", 24)

    expect(host.clears()).toBe(1)
    expect(host.scheduler.cleared).toEqual([0])
  })

  test("advances once per elapsed frame and slews provider corrections", () => {
    const host = setup()
    host.coordinator.setInput(player(), host.key, 24)
    host.coordinator.frame()
    host.setNow(10_100)
    host.scheduler.run()
    expect(host.frames.at(-1)!.phase).toBe(1_100)

    host.coordinator.setInput(
      player({ progress_ms: 1_600, fetched_at: 10_100 }),
      host.key,
      24,
    )
    host.coordinator.frame()
    expect(host.frames.at(-1)!.phase).toBe(1_100)
    expect(host.frames.at(-1)!.correction).toBe(500)

    host.setNow(10_200)
    host.scheduler.run()
    expect(host.frames.at(-1)!.phase).toBe(1_230)
    expect(host.frames.at(-1)!.correction).toBe(470)
  })

  test("settles while paused, stops at baseline, and resumes immediately", () => {
    const host = setup()
    host.coordinator.setInput(player(), host.key, 24)
    host.coordinator.frame()
    expect(host.scheduler.created).toEqual([0])

    host.coordinator.setInput(player({ is_playing: false }), host.key, 24)
    host.coordinator.frame()
    expect(host.scheduler.cleared).toHaveLength(0)
    for (let i = 0; i < 30; i++) {
      host.setNow(host.now() + 100)
      host.scheduler.run()
    }
    expect(host.frames.at(-1)!.stable).toBe(true)
    expect(host.scheduler.cleared).toEqual([0])

    host.coordinator.setInput(player({ is_playing: true }), host.key, 24)
    host.coordinator.frame()
    expect(host.scheduler.created).toEqual([0, 1])
    const resumed = host.frames.at(-1)!.phase
    host.setNow(host.now() + 100)
    host.scheduler.run()
    expect(host.frames.at(-1)!.phase).toBe(resumed + 100)
  })

  test("applies forward and backward seeks", () => {
    const host = setup()
    host.coordinator.setInput(player(), host.key, 24)
    host.coordinator.frame()
    host.setNow(10_100)
    host.coordinator.setInput(
      player({ progress_ms: 9_000, fetched_at: 10_100 }),
      host.key,
      24,
    )
    host.coordinator.frame(true)
    expect(host.frames.at(-1)!.phase).toBe(9_000)
    host.setNow(10_200)
    host.coordinator.setInput(
      player({ progress_ms: 500, fetched_at: 10_200 }),
      host.key,
      24,
    )
    host.coordinator.frame(true)
    expect(host.frames.at(-1)!.phase).toBe(500)
  })

  test("resets before replacement and bar-count renders, but not enrichment", () => {
    const host = setup()
    host.coordinator.setInput(
      player({ track: { ...player().track!, artists: "" } }),
      waveformSeedKey("Track A", "track-a"),
      24,
    )
    host.coordinator.frame()
    host.setNow(10_100)
    host.coordinator.setInput(player(), host.key, 24)
    host.coordinator.frame()
    expect(host.frames.at(-1)!.phase).toBe(1_100)

    host.coordinator.setInput(
      player({
        progress_ms: 50,
        fetched_at: 10_100,
        track: { ...player().track!, name: "Track B" },
      }),
      waveformSeedKey("Track B", "track-a"),
      24,
    )
    host.coordinator.frame()
    expect(host.frames.at(-1)!).toMatchObject({
      key: "Track B",
      phase: 50,
      correction: 0,
    })
    const fresh = createEngine(24, "Track B")
    stepEngine(fresh, {
      track_key: "Track B",
      bars: 24,
      progress_ms: 50,
      fetched_at: 10_100,
      is_playing: true,
      duration_ms: 180_000,
      now_ms: 10_100,
    })
    expect(host.frames.at(-1)!.levels).toEqual([...fresh.levels])

    host.coordinator.setInput(
      player({ progress_ms: 75, fetched_at: 10_100 }),
      host.key,
      16,
    )
    host.coordinator.frame()
    expect(host.frames.at(-1)!.phase).toBe(75)
    expect(host.frames.at(-1)!.levels).toHaveLength(16)
  })

  test("preserves a settled pause through enrichment and resets on one-field conflict", () => {
    const host = setup()
    const incomplete = player({
      is_playing: false,
      progress_ms: 4_000,
      track: { ...player().track!, artists: "" },
    })
    host.coordinator.setInput(
      incomplete,
      waveformSeedKey("Track A", "track-a"),
      16,
    )
    host.coordinator.frame()
    const pausedLevels = host.frames.at(-1)!.levels

    host.setNow(10_100)
    host.coordinator.setInput(
      player({ is_playing: false, progress_ms: 4_000 }),
      host.key,
      16,
    )
    host.coordinator.frame()
    expect(host.frames.at(-1)!.phase).toBe(4_000)
    expect(host.frames.at(-1)!.levels).toEqual(pausedLevels)

    host.coordinator.setInput(
      player({
        is_playing: false,
        progress_ms: 50,
        fetched_at: 10_100,
        track: { ...player().track!, name: "Replacement", artists: "" },
      }),
      waveformSeedKey("Replacement", "track-a"),
      16,
    )
    host.coordinator.frame()
    expect(host.frames.at(-1)).toMatchObject({
      key: "Replacement",
      phase: 50,
    })
  })

  test("cleans up every active timer", () => {
    const host = setup()
    host.coordinator.setInput(player(), host.key, 24)
    host.coordinator.frame()
    host.coordinator.dispose()
    host.coordinator.dispose()
    expect(host.scheduler.cleared).toEqual([0])
  })
})

test("Pi and OpenCode coordinators produce identical deterministic 16-bar frames", () => {
  const host = setup()
  const piFrames: number[][] = []
  const pi = createPiWaveformCoordinator({
    now: host.now,
    scheduler: fakeScheduler(),
    render: (_player, engine) => piFrames.push([...engine.levels]),
  })
  const samples = [
    player(),
    player({ progress_ms: 1_100, fetched_at: 10_100 }),
    player({ progress_ms: 1_200, fetched_at: 10_200 }),
    player({ is_playing: false, progress_ms: 1_200, fetched_at: 10_200 }),
  ]

  for (const [index, sample] of samples.entries()) {
    const now = 10_000 + index * 100
    host.setNow(now)
    host.coordinator.setInput(sample, host.key, 16)
    host.coordinator.frame()
    pi.setPlayer(sample)
    pi.frame()
    expect(host.frames.at(-1)!.levels).toEqual(piFrames.at(-1)!)
  }
})

test("metadata enrichment order keeps Pi and OpenCode on one seed", () => {
  const host = setup()
  const piFrames: number[][] = []
  const pi = createPiWaveformCoordinator({
    now: host.now,
    scheduler: fakeScheduler(),
    render: (_player, engine) => piFrames.push([...engine.levels]),
  })
  const partial = player({
    track: { ...player().track!, id: "", artists: "" },
  })
  const enriched = player()
  const seed = waveformSeedKey(partial.track!.name, partial.track!.id)

  host.coordinator.setInput(partial, seed, 16)
  host.coordinator.frame()
  host.coordinator.setInput(enriched, seed, 16)
  host.coordinator.frame()
  pi.setPlayer(enriched)
  pi.frame()

  expect(host.frames.at(-1)!.key).toBe("Track A")
  expect(host.frames.at(-1)!.levels).toEqual(piFrames.at(-1)!)
})
