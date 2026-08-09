/** @jsxImportSource @opentui/solid */
import { createEngine, stepEngine, type WaveEngine } from "@naxodev/music-core"
import { For, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { Plugin } from "@opencode-ai/plugin/tui"

type Context = Plugin.Context
type Theme = Context["theme"]

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

function blueFor(amp: number, playing: boolean, theme: Theme) {
  if (!playing && amp < 0.05) return theme.text.subdued
  if (amp <= 0.02) return BLUE[1]!
  const idx = Math.min(BLUE.length - 1, Math.floor(amp * (BLUE.length - 1)))
  return BLUE[Math.max(2, idx)]!
}

function blockChar(amp: number): string {
  return BLOCK[Math.max(0, Math.min(8, Math.round(amp * 8)))]!
}

export function Waveform(props: {
  theme: Theme
  playing: boolean
  seedKey?: string | undefined
  progressMs?: number
  bars?: number
  /** kept for API compat — both render a single clean row */
  variant?: "mini" | "hero"
  rows?: number
}) {
  const barCount = () => props.bars ?? (props.variant === "hero" ? 48 : 16)

  let eng: WaveEngine | null = null
  let lastSeedKey = ""
  let originMs = 0
  const [frame, setFrame] = createSignal(0)

  onMount(() => {
    originMs = performance.now()
    const ms = props.variant === "hero" ? 48 : 64
    const id = setInterval(() => {
      const n = barCount()
      const key = props.seedKey || "idle"
      if (!eng || eng.n !== n || lastSeedKey !== key) {
        eng = createEngine(n, key)
        lastSeedKey = key
        originMs = performance.now()
      }
      const tMs = performance.now() - originMs + (props.progressMs ?? 0) * 0.2
      stepEngine(eng, tMs, props.playing, performance.now())
      setFrame((f) => f + 1)
    }, ms)

    onCleanup(() => clearInterval(id))
  })

  const cells = createMemo(() => {
    frame()
    const n = barCount()
    const levels = eng?.levels ?? new Float64Array(n)
    const out: { ch: string; fg: ReturnType<typeof blueFor> }[] = []
    for (let i = 0; i < n; i++) {
      const amp = levels[i] ?? 0
      // paused: flat low baseline
      const a = props.playing
        ? amp
        : amp > 0.02
          ? amp * 0.4
          : i % 4 === 0
            ? 0.12
            : 0
      out.push({
        ch: blockChar(a),
        fg: blueFor(a, props.playing || a > 0.05, props.theme),
      })
    }
    return out
  })

  return (
    <text>
      <For each={cells()}>
        {(c) => <span style={{ fg: c.fg }}>{c.ch}</span>}
      </For>
    </text>
  )
}
