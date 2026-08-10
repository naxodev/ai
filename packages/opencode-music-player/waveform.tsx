/** @jsxImportSource @opentui/solid */
import {
  createEngine,
  displayLevel,
  isFlat,
  sameTrackIdentity,
  stepEngine,
  type WaveEngine,
} from "@naxodev/music-core"
import {
  For,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js"
import type { Plugin } from "@opencode-ai/plugin/tui"
import type { PlayerState } from "./types.ts"

type Context = Plugin.Context
type Theme = Context["theme"]

export type WaveformScheduler = {
  setInterval: (callback: () => void, ms: number) => unknown
  clearInterval: (timer: unknown) => void
}

type WaveformCoordinatorOptions = {
  now: () => number
  scheduler: WaveformScheduler
  render: (player: PlayerState, engine: WaveEngine) => void
  clear: () => void
  intervalMs: number
}

/** OpenCode-owned engine and animation lifecycle, with injectable time and timers. */
export function createWaveformCoordinator(options: WaveformCoordinatorOptions) {
  let player: PlayerState | null = null
  let bars = 0
  let requestedKey = ""
  let engineKey = ""
  let engine: WaveEngine | null = null
  let timer: unknown = null

  const stop = () => {
    if (timer === null) return
    options.scheduler.clearInterval(timer)
    timer = null
  }

  const start = () => {
    if (timer !== null || !player?.track) return
    timer = options.scheduler.setInterval(() => frame(), options.intervalMs)
  }

  const frame = (seek = false) => {
    const track = player?.track
    if (!player || !track) {
      stop()
      return null
    }

    const key = engineKey || requestedKey
    if (!engine || engine.n !== bars || engineKey !== key) {
      engine = createEngine(bars, key)
      engineKey = key
    }
    stepEngine(engine, {
      track_key: key,
      bars,
      progress_ms: player.progress_ms,
      fetched_at: player.fetched_at,
      is_playing: player.is_playing,
      duration_ms: track.duration_ms,
      now_ms: options.now(),
      seek,
    })
    options.render(player, engine)
    if (player.is_playing || !isFlat(engine)) start()
    else stop()
    return engine
  }

  return {
    setInput: (
      next: PlayerState | null,
      trackIdentity: string,
      nextBars: number,
    ) => {
      if (!next?.track) {
        player = null
        engine = null
        engineKey = ""
        requestedKey = ""
        bars = nextBars
        stop()
        options.clear()
        return
      }
      if (
        bars !== nextBars ||
        (player?.track && !sameTrackIdentity(player.track, next.track))
      ) {
        engine = null
        engineKey = ""
      }
      player = next
      requestedKey = trackIdentity
      bars = nextBars
    },
    frame,
    start,
    stop,
    dispose: () => {
      stop()
      player = null
      engine = null
      engineKey = ""
      requestedKey = ""
    },
  }
}

const BLOCK = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

/** Tokyonight blue ramp — low energy → peak (no rainbow). */
const BLUE = [
  "#1a1b26", // void
  "#24283b", // surface
  "#3d59a1", // deep
  "#414868", // comment
  "#565f89", // dark blue-gray
  "#7aa2f7", // blue
  "#89b4fa", // soft blue
  "#b4c0f7", // pale
  "#c0caf5", // foreground flash
] as const

function blueFor(level: number, playing: boolean, theme: Theme) {
  if (!playing && level < 0.05) return theme.text.subdued
  if (level <= 0.02) return BLUE[1]!
  const idx = Math.min(BLUE.length - 1, Math.floor(level * (BLUE.length - 1)))
  return BLUE[Math.max(2, idx)]!
}

function blockChar(level: number): string {
  return BLOCK[Math.max(0, Math.min(8, Math.round(level * 8)))]!
}

export function Waveform(props: {
  theme: Theme
  player: PlayerState | null
  trackIdentity: string
  bars?: number
  /** Kept for API compatibility; both variants render one clean row. */
  variant?: "mini" | "hero"
  rows?: number
}) {
  const barCount = () => props.bars ?? (props.variant === "hero" ? 48 : 16)
  const [rendered, setRendered] = createSignal<{
    player: PlayerState
    engine: WaveEngine
  } | null>(null)
  const coordinator = createWaveformCoordinator({
    now: () => Date.now(),
    scheduler: {
      setInterval,
      clearInterval: (timer) =>
        clearInterval(timer as ReturnType<typeof setInterval>),
    },
    intervalMs: props.variant === "hero" ? 48 : 64,
    render: (player, engine) => setRendered({ player, engine }),
    clear: () => setRendered(null),
  })

  createEffect(() => {
    coordinator.setInput(props.player, props.trackIdentity, barCount())
    coordinator.frame()
  })
  onCleanup(() => coordinator.dispose())

  const cells = createMemo(() => {
    const current = rendered()
    const n = barCount()
    const levels = current?.engine.levels ?? new Float64Array(n)
    const playing = current?.player.is_playing ?? false
    const out: { ch: string; fg: ReturnType<typeof blueFor> }[] = []
    for (let i = 0; i < n; i++) {
      const level = displayLevel(levels[i] ?? 0, i, playing)
      out.push({
        ch: blockChar(level),
        fg: blueFor(level, playing || level > 0.05, props.theme),
      })
    }
    return out
  })

  return (
    <text>
      <For each={cells()}>
        {(cell) => <span style={{ fg: cell.fg }}>{cell.ch}</span>}
      </For>
    </text>
  )
}
