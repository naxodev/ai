/** @jsxImportSource @opentui/solid */
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

function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function fract(n: number): number {
  return n - Math.floor(n)
}

function blueFor(amp: number, playing: boolean, theme: Theme) {
  if (!playing && amp < 0.05) return theme.text.subdued
  if (amp <= 0.02) return BLUE[1]!
  const idx = Math.min(BLUE.length - 1, Math.floor(amp * (BLUE.length - 1)))
  return BLUE[Math.max(2, idx)]!
}

/** Soft multi-band targets — restrained motion. */
function targets(n: number, tSec: number, seed: number): Float64Array {
  const out = new Float64Array(n)
  const bpm = 96 + (seed % 28)
  const beat = ((tSec * bpm) / 60) * Math.PI * 2
  const kick = Math.pow(Math.max(0, Math.sin(beat)), 10)
  const pulse = 0.5 + 0.5 * Math.sin(beat * 2 + 0.3)

  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : i / (n - 1)
    // Gentle EQ curve: a bit more energy on the left
    const shape = 0.55 + 0.45 * Math.exp(-x * 1.8)
    const wobble =
      0.55 * Math.sin(tSec * 1.6 + i * 0.48 + seed * 0.01) +
      0.3 * Math.sin(tSec * 2.9 + i * 0.9) +
      0.15 * Math.sin(tSec * 5.1 + i * 0.2)
    const grain = fract(
      Math.sin(i * 9.1 + Math.floor(tSec * 6) * 17.3 + seed) * 43758.5,
    )

    let v =
      shape *
      (0.32 + 0.28 * kick + 0.22 * pulse + 0.18 * (0.5 + 0.5 * wobble)) *
      (0.82 + 0.18 * grain)

    out[i] = clamp01(v)
  }

  // light blur for a clean silhouette
  const blur = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const l = out[i - 1] ?? out[i]!
    const c = out[i]!
    const r = out[i + 1] ?? out[i]!
    blur[i] = l * 0.2 + c * 0.6 + r * 0.2
  }
  return blur
}

type Engine = {
  n: number
  levels: Float64Array
  seed: number
  lastMs: number
}

function step(eng: Engine, tMs: number, playing: boolean, now: number) {
  const dt = eng.lastMs ? Math.min(0.05, (now - eng.lastMs) / 1000) : 0.016
  eng.lastMs = now

  if (!playing) {
    for (let i = 0; i < eng.n; i++) {
      eng.levels[i] = Math.max(0, eng.levels[i]! * Math.exp(-dt * 5))
    }
    return
  }

  const tgt = targets(eng.n, tMs / 1000, eng.seed)
  const attack = 1 - Math.exp(-dt * 18)
  const release = 1 - Math.exp(-dt * 5)
  for (let i = 0; i < eng.n; i++) {
    const cur = eng.levels[i]!
    const want = tgt[i]!
    const a = want > cur ? attack : release
    eng.levels[i] = cur + (want - cur) * a
  }
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

  let eng: Engine | null = null
  let originMs = 0
  const [frame, setFrame] = createSignal(0)

  onMount(() => {
    originMs = performance.now()
    const ms = props.variant === "hero" ? 48 : 64
    const id = setInterval(() => {
      const n = barCount()
      const seed = hashSeed(props.seedKey || "idle")
      if (!eng || eng.n !== n || eng.seed !== seed) {
        eng = { n, levels: new Float64Array(n), seed, lastMs: 0 }
        originMs = performance.now()
      }
      const tMs = performance.now() - originMs + (props.progressMs ?? 0) * 0.2
      step(eng, tMs, props.playing, performance.now())
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
