/** @jsxImportSource @opentui/solid */
import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { Plugin } from "@opencode-ai/plugin/tui"
import { formatMs } from "./types.ts"
import { AlbumArtwork } from "./artwork.tsx"
import { Waveform } from "./waveform.tsx"

export type UiState = {
  loading: boolean
  error: string | null
  player: import("./types.ts").PlayerState | null
}

type Theme = Context["theme"]
type Context = Plugin.Context

/** Text presentation keeps media symbols single-cell on emoji fonts. */
const t = (s: string) => s + "\uFE0E"
const Icon = {
  prev: t("⏮"),
  next: t("⏭"),
  play: t("▶"),
  pause: t("⏸"),
  dotOn: "●",
  dotOff: "○",
  scrub: "●",
} as const

/** Matches artwork / waveform / progress content width. */
export const TRANSPORT_CONTENT_WIDTH = 24

/** Pre-change baseline — documented for tests; do not use as live sizes. */
export const TRANSPORT_BASELINE = {
  prevWidth: 5,
  playWidth: 7,
  nextWidth: 5,
  height: 1,
  gap: 1,
} as const

export const TRANSPORT_LAYOUT = {
  prevWidth: 6,
  playWidth: 10,
  nextWidth: 6,
  /** Shared enlarged hit height for all three controls. */
  height: 2,
  gap: 1,
} as const

export function transportRowWidth(
  layout: {
    prevWidth: number
    playWidth: number
    nextWidth: number
    gap: number
  } = TRANSPORT_LAYOUT,
): number {
  return (
    layout.prevWidth +
    layout.gap +
    layout.playWidth +
    layout.gap +
    layout.nextWidth
  )
}

function liveProgress(player: UiState["player"]): number {
  if (!player?.track) return 0
  if (!player.is_playing) return player.progress_ms
  return Math.min(
    player.track.duration_ms,
    player.progress_ms + (Date.now() - player.fetched_at),
  )
}

function ProgressBar(props: {
  theme: Theme
  progress: number
  duration: number
  width?: number
  accent?: string | undefined
}) {
  const rendered = createMemo(() => {
    const w = Math.max(8, props.width ?? 28)
    if (props.duration <= 0) {
      return { left: "", thumb: "", right: "─".repeat(w) }
    }
    const ratio = Math.max(0, Math.min(1, props.progress / props.duration))
    // leave 1 cell for thumb
    const track = w - 1
    const filled = Math.max(0, Math.min(track, Math.round(ratio * track)))
    return {
      left: "━".repeat(filled),
      thumb: Icon.scrub,
      right: "─".repeat(Math.max(0, track - filled)),
    }
  })

  return (
    <text>
      <span
        style={{ fg: props.accent ?? props.theme.text.action.primary.default }}
      >
        {rendered().left}
      </span>
      <span
        style={{ fg: props.accent ?? props.theme.text.action.primary.default }}
      >
        {rendered().thumb}
      </span>
      <span style={{ fg: props.theme.text.subdued }}>{rendered().right}</span>
    </text>
  )
}

/** Hover/press icon button — props read in JSX (Solid setup is once). */
function IconBtn(props: {
  theme: Theme
  icon: string
  /** Accessible / tooltip-ish label shown nowhere — reserved */
  title?: string
  /** Emphasized play control */
  primary?: boolean
  /** Currently “on” (playing) */
  active?: boolean
  accent?: string | undefined
  /** Fixed outer width in cells */
  width?: number
  /** Fixed outer height in cells */
  height?: number
  onClick: () => void
}) {
  const [hover, setHover] = createSignal(false)
  const [press, setPress] = createSignal(false)

  const bg = () => {
    if (press() || props.active) {
      return props.theme.background.action.primary.default
    }
    // Idle + hover share offset so the cluster reads as one control strip
    return props.theme.background.surface.offset
  }

  const fg = () => {
    if (press() || props.active)
      return props.accent ?? props.theme.text.action.primary.default
    if (props.primary) {
      return hover()
        ? props.theme.text.action.primary.default
        : props.theme.text.default
    }
    return hover()
      ? props.theme.text.action.primary.default
      : props.theme.text.default
  }

  const w = () => props.width ?? 3
  const h = () => props.height ?? 1

  return (
    <box
      onMouseDown={() => {
        setPress(true)
        props.onClick()
      }}
      onMouseUp={() => setPress(false)}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => {
        setHover(false)
        setPress(false)
      }}
      flexShrink={0}
      width={w()}
      height={h()}
      alignItems="center"
      justifyContent="center"
      backgroundColor={bg()}
    >
      <text fg={fg()}>{props.icon}</text>
    </box>
  )
}

function StatusPill(props: {
  theme: Theme
  playing: boolean
  accent?: string | undefined
}) {
  return (
    <box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
      <text
        fg={
          props.playing
            ? (props.accent ?? props.theme.text.action.primary.default)
            : props.theme.text.subdued
        }
      >
        {props.playing ? Icon.dotOn : Icon.dotOff}
      </text>
      <text fg={props.theme.text.subdued}>
        {props.playing ? "playing" : "paused"}
      </text>
    </box>
  )
}

export function SidebarPlayer(props: {
  context: Context
  state: UiState
  onPlayPause: () => void
  onNext: () => void
  onPrev: () => void
}) {
  const theme = () => props.context.theme
  const player = createMemo(() => props.state.player)
  const track = createMemo(() => player()?.track)
  const playing = createMemo(() => !!player()?.is_playing)

  const [tick, setTick] = createSignal(0)
  onMount(() => {
    let id: ReturnType<typeof setInterval> | null = null
    const sync = () => {
      const on = !!props.state.player?.is_playing
      if (on && !id) id = setInterval(() => setTick((t) => t + 1), 1000)
      else if (!on && id) {
        clearInterval(id)
        id = null
      }
    }
    sync()
    const watch = setInterval(sync, 400)
    onCleanup(() => {
      if (id) clearInterval(id)
      clearInterval(watch)
    })
  })

  const progress = createMemo(() => {
    tick()
    return liveProgress(player())
  })
  const duration = createMemo(() => track()?.duration_ms ?? 0)

  return (
    <box
      flexDirection="column"
      border={["top"]}
      borderColor={
        playing()
          ? (track()?.artwork?.accent ?? theme().text.action.primary.default)
          : theme().border.default
      }
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      gap={1}
      flexShrink={0}
    >
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <text fg={theme().text.default}>
          <b>Now playing</b>
        </text>
        <StatusPill
          theme={theme()}
          playing={playing()}
          accent={track()?.artwork?.accent}
        />
      </box>

      <Show when={props.state.error}>
        {(err) => <text fg={theme().text.feedback.error.default}>{err()}</text>}
      </Show>

      <box flexDirection="row" justifyContent="center">
        <box width={24} height={12} overflow="hidden">
          <Show when={track()?.artwork}>
            {(artwork) => (
              <AlbumArtwork context={props.context} artwork={artwork()} />
            )}
          </Show>
        </box>
      </box>

      <Show
        when={track()}
        fallback={
          <text fg={theme().text.subdued}>
            {props.state.loading ? "Syncing…" : "Nothing playing"}
          </text>
        }
      >
        {(t) => (
          <box flexDirection="column" gap={0}>
            <text fg={theme().text.default}>
              <b>{t().name}</b>
            </text>
            <Show when={t().artists}>
              <text fg={theme().text.subdued}>{t().artists}</text>
            </Show>
            <Show when={t().album}>
              <text fg={theme().text.subdued}>{t().album}</text>
            </Show>
          </box>
        )}
      </Show>

      <box flexDirection="row" justifyContent="center" overflow="hidden">
        <Waveform
          theme={theme()}
          playing={playing()}
          seedKey={track()?.id ?? track()?.name}
          progressMs={progress()}
          bars={24}
          variant="hero"
        />
      </box>

      <Show when={track() && duration() > 0}>
        <box flexDirection="column" gap={0} overflow="hidden">
          <ProgressBar
            theme={theme()}
            progress={progress()}
            duration={duration()}
            width={24}
            accent={track()?.artwork?.accent}
          />
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme().text.subdued}>{formatMs(progress())}</text>
            <text fg={theme().text.subdued}>{formatMs(duration())}</text>
          </box>
        </box>
      </Show>

      <box
        flexDirection="row"
        gap={TRANSPORT_LAYOUT.gap}
        justifyContent="center"
      >
        <IconBtn
          theme={theme()}
          icon={Icon.prev}
          width={TRANSPORT_LAYOUT.prevWidth}
          height={TRANSPORT_LAYOUT.height}
          onClick={() => props.onPrev()}
        />
        <IconBtn
          theme={theme()}
          icon={playing() ? Icon.pause : Icon.play}
          primary
          active={playing()}
          accent={track()?.artwork?.accent}
          width={TRANSPORT_LAYOUT.playWidth}
          height={TRANSPORT_LAYOUT.height}
          onClick={() => props.onPlayPause()}
        />
        <IconBtn
          theme={theme()}
          icon={Icon.next}
          width={TRANSPORT_LAYOUT.nextWidth}
          height={TRANSPORT_LAYOUT.height}
          onClick={() => props.onNext()}
        />
      </box>
    </box>
  )
}
