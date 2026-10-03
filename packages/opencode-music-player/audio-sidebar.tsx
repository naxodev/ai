/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { MouseButton, type RGBA } from "@opentui/core"
import { createMemo, createSignal, onCleanup, untrack } from "solid-js"
import {
  audioVisualizationCapability,
  baselineCapabilities,
  createMusicSessionClient,
} from "@naxodev/music-core"
import {
  audioStyles,
  createAudioVisualization,
  isAudioStyle,
  renderAudioFeatures,
  type AudioConnection,
  type AudioStyle,
} from "./audio-visualization.ts"
import { sanitizeTerminalText } from "./ui.tsx"
import { createAudioDialogWaits } from "./audio-dialogs.ts"

type Model = ReturnType<typeof createAudioVisualization>

export function AudioSidebar(props: {
  model: Model
  width: number
  height: number
  foreground: RGBA
  muted: RGBA
  onError: (error: unknown) => void
}) {
  const [state, setState] = createSignal(props.model.current())
  const unsubscribe = props.model.subscribe(setState)
  const rows = () => (props.height >= 60 ? 6 : props.height >= 42 ? 4 : 1)
  const width = () => Math.max(1, Math.min(24, props.width - 6))
  const text = (value: string) => sanitizeTerminalText(value).slice(0, width())
  const signal = createMemo(() =>
    renderAudioFeatures(
      state().active ? state().frame : null,
      state().style,
      width(),
      rows(),
    ).join("\n"),
  )
  onCleanup(() => {
    unsubscribe()
    // The mounted view owns its connection. Hiding it releases joined interest.
    props.model.dispose().catch(props.onError)
  })
  return (
    <box flexDirection="column" flexShrink={0} gap={1}>
      <text fg={props.foreground}>
        <b>{text("REAL AUDIO · DAEMON")}</b>
      </text>
      <text fg={props.muted}>
        {text(state().selected?.label ?? "Not selected")}
      </text>
      <text fg={props.muted}>
        {text(
          `${state().style}${state().style === "scope" && rows() === 1 ? " (envelope)" : ""}`,
        )}
      </text>
      <text fg={props.muted}>{text(state().message)}</text>
      <text fg={props.foreground}>{signal()}</text>
    </box>
  )
}

/** Local-only entry. The released plugin and its daemon discovery stay unchanged. */
export function createLocalAudioPlugin(
  socketPath: string,
  connect?: () => Promise<AudioConnection>,
) {
  if (!socketPath.startsWith("/"))
    throw new Error("Local audio requires an explicit absolute socket path")
  return Plugin.define({
    id: "local.music-audio-daemon",
    setup(context) {
      const [stored, persist] = context.storage.store<{ style: AudioStyle }>(
        "music-player.audio-style.v1",
        { initial: { style: "spectrum" } },
      )
      let mounted: Model | undefined
      let disposed = false
      const dialogs = createAudioDialogWaits()
      const actions = new Set<Promise<void>>()
      const report = (error: unknown) => {
        if (disposed) return
        context.ui.toast.show({
          title: "Local audio",
          variant: "error",
          message: sanitizeTerminalText(
            error instanceof Error ? error.message : String(error),
          ).slice(0, 240),
        })
      }
      const current = () => {
        if (!mounted)
          throw new Error("Open the sidebar before using local audio")
        return mounted
      }
      const chooseSource = async () =>
        current().chooseSource(async (list) => {
          const token = await dialogs.run(() =>
            context.ui.dialog.select({
              title: "Local daemon source — capture is off",
              options: list.sources.map((source) => ({
                title: source.label,
                value: source.token,
                description:
                  "All output from this exact process; no automatic replacement",
              })),
            }),
          )
          return list.sources.find((source) => source.token === token)
        })
      const chooseStyle = async () => {
        const model = current()
        const selected = await dialogs.run(() =>
          context.ui.dialog.select({
            title: "Local daemon visualization style",
            current: model.current().style,
            options: audioStyles.map((style) => ({
              title: style,
              value: style,
            })),
          }),
        )
        if (
          selected &&
          isAudioStyle(selected) &&
          mounted === model &&
          !disposed
        ) {
          model.setStyle(selected)
          await persist((draft) => {
            draft.style = selected
          })
        }
      }
      const action = (operation: () => Promise<unknown>) => {
        // Plugin actions own their Promise and retain visible failures.
        command(operation)().catch(report)
      }
      const command = (operation: () => Promise<unknown>) => () => {
        if (disposed) return Promise.resolve()
        const pending = Promise.resolve()
          .then(() => (disposed ? undefined : operation()))
          .then(() => undefined)
          .catch(report)
          .finally(() => actions.delete(pending))
        actions.add(pending)
        return pending
      }
      const unregisterSidebar = context.ui.slot({
        append: "sidebar.content",
        render: () => {
          const model = createAudioVisualization({
            // A style-store update must not recreate the slot or its connection.
            initialStyle: untrack(() =>
              isAudioStyle(stored.style) ? stored.style : "spectrum",
            ),
            connect:
              connect ??
              (() =>
                createMusicSessionClient({
                  socketPath,
                  clientId: crypto.randomUUID(),
                  hostKind: "opencode",
                  capabilities: [
                    ...baselineCapabilities,
                    audioVisualizationCapability,
                  ],
                })),
            confirm: async (source) =>
              (await dialogs.run(() =>
                context.ui.dialog.confirm({
                  title: "Capture selected process",
                  message: `${source.label}\nCapture all output from this exact process while joined. No audio is saved. This local cache attribution is not a production ownership guarantee.`,
                }),
              )) === true,
            cancelPendingDialogs: async () => dialogs.cancel(),
          })
          mounted = model
          const [size, setSize] = createSignal({
            width: context.renderer.terminalWidth,
            height: context.renderer.terminalHeight,
          })
          const resized = () =>
            setSize({
              width: context.renderer.terminalWidth,
              height: context.renderer.terminalHeight,
            })
          context.renderer.on("resize", resized)
          onCleanup(() => {
            context.renderer.off("resize", resized)
            if (mounted === model) mounted = undefined
          })
          const button = (label: string, operation: () => Promise<unknown>) => (
            <box
              onMouseDown={(event) => {
                if (event.button === MouseButton.LEFT) {
                  event.stopPropagation()
                  action(operation)
                }
              }}
            >
              <text>
                {label.slice(0, Math.max(1, Math.min(24, size().width - 6)))}
              </text>
            </box>
          )
          return (
            <box
              border={["top"]}
              borderColor={context.theme.border.base}
              padding={1}
              gap={1}
              flexDirection="column"
              flexShrink={0}
            >
              <AudioSidebar
                model={model}
                width={size().width}
                height={size().height}
                foreground={context.theme.text.action.primary.base}
                muted={context.theme.text.muted}
                onError={report}
              />
              <box flexDirection={size().width < 30 ? "column" : "row"} gap={1}>
                {button("Source", chooseSource)}
                {button("Style", chooseStyle)}
                {button("Start", () => model.start())}
                {button("Stop", () => model.stop())}
              </box>
            </box>
          )
        },
      })
      const unregisterCommands = context.ui.slot({
        append: "app",
        render: () => {
          context.keymap.layer(() => ({
            mode: "global",
            commands: [
              {
                id: "local-audio.source",
                title: "Choose local daemon audio source",
                group: "Local audio",
                palette: true,
                slash: { name: "live-audio-source" },
                run: command(chooseSource),
              },
              {
                id: "local-audio.style",
                title: "Choose local daemon visualization style",
                group: "Local audio",
                palette: true,
                slash: { name: "live-audio-style" },
                run: command(chooseStyle),
              },
              {
                id: "local-audio.start",
                title: "Start or join local daemon capture",
                group: "Local audio",
                palette: true,
                slash: { name: "live-audio-start" },
                run: command(() => current().start()),
              },
              {
                id: "local-audio.stop",
                title: "Stop shared local daemon capture",
                group: "Local audio",
                palette: true,
                slash: { name: "live-audio-stop" },
                run: command(() => current().stop()),
              },
            ],
          }))
          return null
        },
      })
      return async () => {
        disposed = true
        dialogs.cancel()
        const model = mounted
        unregisterCommands()
        unregisterSidebar()
        await model?.dispose()
        await Promise.allSettled([...actions])
      }
    },
  })
}
