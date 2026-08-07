/** @jsxImportSource @opentui/solid */
import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { Plugin } from "@opencode-ai/plugin/tui"
import { formatMs, type Device, type Track } from "./types.ts"
import { Waveform } from "./waveform.tsx"

export type UiState = {
  loading: boolean
  error: string | null
  query: string
  results: Track[]
  selected: number
  devices: Device[]
  player: import("./types.ts").PlayerState | null
  view: "now" | "search" | "devices"
  expanded: boolean
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
  refresh: "↻",
  open: "↗",
  expand: "▴",
  collapse: "▾",
  dotOn: "●",
  dotOff: "○",
  scrub: "●",
  sep: "·",
} as const

function liveProgress(player: UiState["player"]): number {
  if (!player?.track) return 0
  if (!player.is_playing) return player.progress_ms
  return Math.min(
    player.track.duration_ms,
    player.progress_ms + (Date.now() - player.fetched_at),
  )
}

function clipWords(text: string, max = 6): string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length <= max) return text.trim()
  return `${words.slice(0, max).join(" ")}…`
}

function ProgressBar(props: {
  theme: Theme
  progress: number
  duration: number
  width?: number
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
      <span style={{ fg: props.theme.text.action.primary.default }}>
        {rendered().left}
      </span>
      <span style={{ fg: props.theme.text.action.primary.default }}>
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
  muted?: boolean
  /** Fixed outer width in cells */
  width?: number
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
    if (press() || props.active) return props.theme.text.action.primary.default
    if (props.primary) {
      return hover()
        ? props.theme.text.action.primary.default
        : props.theme.text.default
    }
    if (props.muted) {
      return hover() ? props.theme.text.default : props.theme.text.subdued
    }
    return hover()
      ? props.theme.text.action.primary.default
      : props.theme.text.default
  }

  const w = () => props.width ?? 3

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
      height={1}
      alignItems="center"
      justifyContent="center"
      backgroundColor={bg()}
    >
      <text fg={fg()}>{props.icon}</text>
    </box>
  )
}

function KeyChip(props: { theme: Theme; keys: string; label: string }) {
  return (
    <text>
      <span style={{ fg: props.theme.text.action.primary.default }}>
        {props.keys}
      </span>
      <span style={{ fg: props.theme.text.subdued }}> {props.label} </span>
    </text>
  )
}

function StatusPill(props: {
  theme: Theme
  playing: boolean
  source: string | null
}) {
  return (
    <box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
      <text
        fg={
          props.playing
            ? props.theme.text.action.primary.default
            : props.theme.text.subdued
        }
      >
        {props.playing ? Icon.dotOn : Icon.dotOff}
      </text>
      <text fg={props.theme.text.subdued}>
        {props.playing ? "playing" : "paused"}
        {props.source ? ` ${Icon.sep} ${props.source}` : ""}
      </text>
    </box>
  )
}

export function FooterDock(props: {
  context: Context
  state: UiState
  onToggleExpand: () => void
  onPlayPause: () => void
  onNext: () => void
  onPrev: () => void
  onRefresh: () => void
  onOpenApp: () => void
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
  const source = createMemo(() => player()?.device?.name ?? null)

  return (
    <box
      position="absolute"
      left={0}
      right={0}
      bottom={1}
      zIndex={50}
      flexDirection="column"
      backgroundColor={theme().background.surface.overlay}
      border={["top"]}
      borderColor={
        playing() ? theme().text.action.primary.default : theme().border.default
      }
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
      flexShrink={0}
    >
      {/* ── main transport row ── */}
      <box
        flexDirection="row"
        gap={1}
        height={1}
        alignItems="center"
        justifyContent="space-between"
      >
        {/* Transport cluster */}
        <box
          flexDirection="row"
          gap={0}
          alignItems="center"
          flexShrink={0}
          backgroundColor={theme().background.surface.offset}
          paddingLeft={0}
          paddingRight={0}
        >
          <IconBtn
            theme={theme()}
            icon={Icon.prev}
            width={3}
            onClick={() => props.onPrev()}
          />
          <IconBtn
            theme={theme()}
            icon={playing() ? Icon.pause : Icon.play}
            primary
            active={playing()}
            width={3}
            onClick={() => props.onPlayPause()}
          />
          <IconBtn
            theme={theme()}
            icon={Icon.next}
            width={3}
            onClick={() => props.onNext()}
          />
        </box>

        <Waveform
          theme={theme()}
          playing={playing()}
          seedKey={track()?.id ?? track()?.name}
          progressMs={progress()}
          bars={18}
          variant="mini"
        />

        {/* Title */}
        <box
          flexGrow={1}
          minWidth={10}
          flexShrink={1}
          overflow="hidden"
          onMouseDown={() => props.onToggleExpand()}
        >
          <Show
            when={track()}
            fallback={
              <text fg={theme().text.subdued}>
                {props.state.loading ? "syncing…" : "Nothing playing"}
              </text>
            }
          >
            {(t) => (
              <text fg={theme().text.default}>
                <b>{clipWords(t().name, 6)}</b>
                <Show when={t().artists}>
                  <span style={{ fg: theme().text.subdued }}>
                    {`  ${Icon.sep}  ${clipWords(t().artists, 4)}`}
                  </span>
                </Show>
              </text>
            )}
          </Show>
        </box>

        {/* Utility cluster */}
        <box flexDirection="row" gap={0} alignItems="center" flexShrink={0}>
          <IconBtn
            theme={theme()}
            icon={Icon.refresh}
            muted
            width={3}
            onClick={() => props.onRefresh()}
          />
          <IconBtn
            theme={theme()}
            icon={Icon.open}
            muted
            width={3}
            onClick={() => props.onOpenApp()}
          />
          <IconBtn
            theme={theme()}
            icon={props.state.expanded ? Icon.collapse : Icon.expand}
            muted
            width={3}
            onClick={() => props.onToggleExpand()}
          />
        </box>
      </box>

      {/* ── progress ── */}
      <Show when={track() && duration() > 0}>
        <box
          flexDirection="row"
          gap={1}
          height={1}
          alignItems="center"
          paddingLeft={1}
          paddingRight={1}
        >
          <box width={5} flexShrink={0}>
            <text fg={theme().text.subdued}>
              {formatMs(progress()).padStart(5)}
            </text>
          </box>
          <box flexGrow={1} flexShrink={1} overflow="hidden">
            <ProgressBar
              theme={theme()}
              progress={progress()}
              duration={duration()}
              width={52}
            />
          </box>
          <box width={5} flexShrink={0} alignItems="flex-end">
            <text fg={theme().text.subdued}>
              {formatMs(duration()).padStart(5)}
            </text>
          </box>
        </box>
      </Show>

      {/* ── expanded ── */}
      <Show when={props.state.expanded}>
        <box
          flexDirection="column"
          gap={1}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={1}
          paddingRight={1}
          border={["top"]}
          borderColor={theme().border.default}
        >
          <Show when={props.state.error}>
            {(err) => (
              <text fg={theme().text.feedback.error.default}>{err()}</text>
            )}
          </Show>

          <box flexDirection="row" gap={2} alignItems="center">
            <text fg={theme().text.default}>
              <b>Now playing</b>
            </text>
            <StatusPill theme={theme()} playing={playing()} source={source()} />
            <box flexGrow={1} />
            <Show when={track()?.album}>
              <text fg={theme().text.subdued}>{track()!.album}</text>
            </Show>
          </box>

          <Show when={track()}>
            {(t) => (
              <box flexDirection="column" gap={0}>
                <text fg={theme().text.default}>
                  <b>{t().name}</b>
                </text>
                <Show when={t().artists}>
                  <text fg={theme().text.subdued}>{t().artists}</text>
                </Show>
              </box>
            )}
          </Show>

          {/* Large transport */}
          <box
            flexDirection="row"
            gap={1}
            alignItems="center"
            justifyContent="center"
          >
            <IconBtn
              theme={theme()}
              icon={Icon.prev}
              width={5}
              onClick={() => props.onPrev()}
            />
            <IconBtn
              theme={theme()}
              icon={playing() ? Icon.pause : Icon.play}
              primary
              active={playing()}
              width={7}
              onClick={() => props.onPlayPause()}
            />
            <IconBtn
              theme={theme()}
              icon={Icon.next}
              width={5}
              onClick={() => props.onNext()}
            />
          </box>

          <box flexDirection="row" justifyContent="center">
            <Waveform
              theme={theme()}
              playing={playing()}
              seedKey={track()?.id ?? track()?.name}
              progressMs={progress()}
              bars={48}
              variant="hero"
            />
          </box>

          <box flexDirection="row" gap={1} flexWrap="wrap">
            <KeyChip theme={theme()} keys="⌃⇧M" label="dock" />
            <KeyChip theme={theme()} keys="⌃⇧P" label="play" />
            <KeyChip theme={theme()} keys="⌃⇧←→" label="skip" />
            <KeyChip theme={theme()} keys="space" label="play" />
            <KeyChip theme={theme()} keys="esc" label="close" />
          </box>
        </box>
      </Show>
    </box>
  )
}
