/** @jsxImportSource @opentui/solid */
/** LOCAL-ONLY sidebar preview. Capture is off until the user explicitly starts it. */
import { Plugin } from "@opencode/plugin/tui"
import { MouseButton } from "@opentui/core"
import { createMemo, createSignal } from "solid-js"
import { createAudioDialogWaits } from "../../audio-dialogs.ts"
import { frame, render, styles, type Frame, type Style } from "./run.ts"
import {
  consumeFeatureLines,
  drainDiagnostics,
  readProcessOutput,
  ReaderCleanupError,
} from "./streams.ts"

declare const AUDIO_PROTOTYPE_ROOT: string
const helper = `${typeof AUDIO_PROTOTYPE_ROOT === "string" ? AUDIO_PROTOTYPE_ROOT : import.meta.dir}/dist/audio-probe`
type Reader = (command: string[], signal?: AbortSignal) => Promise<unknown>
type CaptureChild = {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill: (signal: "SIGTERM" | "SIGKILL") => unknown
}

/** Retire an unpublished child without waiting on its own action or shutdown. */
async function retireCapture(input: CaptureChild): Promise<void> {
  const exited = input.exited.then(
    () => true,
    () => false,
  )
  let killFailed = false
  const kill = (signal: "SIGTERM" | "SIGKILL") => {
    try {
      input.kill(signal)
    } catch {
      killFailed = true
    }
  }
  kill("SIGTERM")
  const deadline = setTimeout(() => kill("SIGKILL"), 1_000)
  const readers = new AbortController()
  readers.abort()
  try {
    const [exit, stdout, stderr] = await Promise.allSettled([
      exited,
      drainDiagnostics(input.stdout, readers.signal),
      drainDiagnostics(input.stderr, readers.signal),
    ])
    if (
      killFailed ||
      exit.status === "rejected" ||
      !exit.value ||
      stdout.status === "rejected" ||
      stderr.status === "rejected"
    )
      throw new Error("Capture retirement failed")
  } finally {
    clearTimeout(deadline)
  }
}
type ProcessSource = {
  pid: number
  object: number
  bundle: string
  name: string
  runningOutput?: boolean
}
type Choice =
  | { kind: "cliamp" }
  | { kind: "auto" }
  | { kind: "kaset"; process: ProcessSource }
  | { kind: "native"; process: ProcessSource }

const clean = (text: string) =>
  text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 160)
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

async function readJSON(
  command: string[],
  signal?: AbortSignal,
): Promise<unknown> {
  const text = await readProcessOutput(command, { signal })
  try {
    return command[0] === "lsof" ? text : (JSON.parse(text) as unknown)
  } catch {
    throw new Error("Metadata response was not valid JSON")
  }
}

async function processes(read: Reader = readJSON): Promise<ProcessSource[]> {
  const result = await read([helper, "--list"])
  if (
    !object(result) ||
    !Array.isArray(result.processes) ||
    result.processes.length > 1024
  )
    throw new Error("Invalid process list")
  return result.processes.filter(
    (entry: unknown): entry is ProcessSource =>
      object(entry) &&
      Number.isInteger(entry.pid) &&
      Number(entry.pid) > 0 &&
      Number.isInteger(entry.object) &&
      typeof entry.name === "string" &&
      typeof entry.bundle === "string" &&
      (entry.runningOutput === undefined ||
        typeof entry.runningOutput === "boolean"),
  )
}

function musicCandidate(source: ProcessSource) {
  return (
    ["cliamp", "mpv", "Music", "Spotify", "VLC", "IINA"].includes(
      source.name,
    ) ||
    [
      "com.spotify.",
      "com.apple.Music",
      "org.videolan.",
      "com.colliderli.iina",
      "io.mpv.",
    ].some((prefix) => source.bundle.startsWith(prefix))
  )
}

async function kasetAttribution(source: ProcessSource, read: Reader) {
  if (
    source.bundle !== "com.apple.WebKit.GPU" ||
    source.name !== "com.apple.WebKit.GPU" ||
    source.runningOutput !== true
  )
    return false
  const paths = await read([
    "lsof",
    "-a",
    "-p",
    String(source.pid),
    "-d",
    "txt",
    "-Fn",
  ])
  // This is the local association checked in the Kaset isolation experiment.
  // It is not a production ownership contract or a selector for all WebKit audio.
  return (
    typeof paths === "string" &&
    paths.length <= 64 * 1024 &&
    paths
      .split("\n")
      .some((line) =>
        /^n\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/C\/com\.apple\.WebKit\.GPU\+com\.sertacozercan\.Kaset\/com\.apple\.WebKit\.GPU\//.test(
          line,
        ),
      )
  )
}

async function kasetSource(read: Reader): Promise<ProcessSource> {
  const list = await processes(read)
  const candidates = list.filter(
    (source) =>
      source.bundle === "com.apple.WebKit.GPU" &&
      source.name === "com.apple.WebKit.GPU" &&
      source.runningOutput === true,
  )
  if (candidates.length > 32)
    throw new Error("Too many WebKit candidates; Kaset attribution unavailable")
  const matches = (
    await Promise.all(
      candidates.map(async (source) =>
        (await kasetAttribution(source, read)) ? source : null,
      ),
    )
  ).filter((source): source is ProcessSource => source !== null)
  if (matches.length !== 1)
    throw new Error(
      matches.length > 1
        ? "Kaset has multiple attributed audio helpers; no capture started"
        : "No active Kaset-attributed WebKit audio process; play Kaset and select it again",
    )
  return matches[0]!
}

async function requireKasetAttribution(source: ProcessSource, read: Reader) {
  if (!(await kasetAttribution(source, read)))
    throw new Error("Kaset audio attribution changed; select the source again")
}

async function automatic(read: Reader = readJSON): Promise<ProcessSource> {
  const [metadata, list] = await Promise.all([
    read(["media-control", "get", "--no-artwork", "--now"]),
    processes(read),
  ])
  if (
    !object(metadata) ||
    metadata.playing !== true ||
    !Number.isInteger(metadata.processIdentifier)
  )
    throw new Error(
      "No active Now Playing source; choose a music process manually",
    )
  const bundle =
    metadata.parentApplicationBundleIdentifier || metadata.bundleIdentifier
  const source = list.find((entry) => entry.pid === metadata.processIdentifier)
  // A shared WebKit/helper bundle is not independently verified app ownership.
  if (!source || source.bundle !== bundle || !musicCandidate(source))
    throw new Error(
      "Now Playing audio ownership is unresolved; no capture started",
    )
  return source
}

/** Narrow I/O seam for lifecycle regressions; no fake source in normal setup. */
export function createAudioPrototype(
  overrides: {
    read?: Reader
    spawn?: (command: string[]) => CaptureChild
  } = {},
) {
  const rawRead = overrides.read ?? readJSON
  const spawn =
    overrides.spawn ??
    ((command: string[]) =>
      Bun.spawn(command, { stdout: "pipe", stderr: "pipe" }))
  return Plugin.define({
    id: "local.music-audio-prototype",
    setup(context) {
      const [choice, setChoice] = createSignal<Choice | null>(null)
      const [style, setStyle] = createSignal<Style>("spectrum")
      const [signal, setSignal] = createSignal<Frame | null>(null)
      const [status, setStatus] = createSignal("Capture off — choose a source")
      const [running, setRunning] = createSignal(false)
      const [lastFrame, setLastFrame] = createSignal(0)
      const [clock, setClock] = createSignal(Date.now())
      let child: CaptureChild | null = null
      let cancelReaders: (() => void) | null = null
      let task: Promise<void> | null = null
      let shutdown = Promise.resolve()
      let changingSource = false
      let generation = 0
      let disposed = false
      const lifetime = new AbortController()
      const dialogs = createAudioDialogWaits()
      const actions = new Set<Promise<void>>()
      const reads = new Set<Promise<unknown>>()
      const launches = new Set<Promise<void>>()
      let retirementFailed = false
      let cleanupFailed = false
      const readFor =
        (token: number): Reader =>
        async (command) => {
          if (disposed || token !== generation)
            throw new Error("Audio operation cancelled")
          // A sibling Promise.all failure must not release ownership of this read.
          const owned = Promise.resolve().then(() => {
            if (disposed || token !== generation)
              throw new Error("Audio operation cancelled")
            return rawRead(command, lifetime.signal)
          })
          reads.add(owned)
          let result: unknown
          try {
            // A reader must settle after abort. We join even an uncooperative override.
            result = await owned
          } catch (error) {
            if (error instanceof ReaderCleanupError) cleanupFailed = true
            throw new Error("Metadata read failed")
          } finally {
            reads.delete(owned)
          }
          if (disposed || token !== generation)
            throw new Error("Audio operation cancelled")
          return result
        }
      const waitDialog = async <A,>(show: () => Promise<A | undefined>) => {
        if (disposed) return undefined
        try {
          return await dialogs.run(show)
        } catch {
          throw new Error("Audio dialog failed")
        }
      }
      const failure = (error: unknown) => {
        if (disposed) return
        const message = clean(
          error instanceof Error ? error.message : String(error),
        )
        setStatus(message)
        context.ui.toast.show({
          title: "Local audio prototype",
          message,
          variant: "error",
        })
      }

      const stop = async (reason = "Capture off") => {
        const token = ++generation
        const previous = child
        const previousTask = task
        const previousReaders = cancelReaders
        const pendingLaunches = [...launches]
        child = null
        task = null
        cancelReaders = null
        previous?.kill("SIGTERM")
        previousReaders?.()
        if (!disposed) {
          setRunning(false)
          setSignal(null)
          setStatus(reason)
        }
        const deadline = previous
          ? setTimeout(() => previous.kill("SIGKILL"), 1_000)
          : undefined
        const wait = async () => {
          try {
            await Promise.all([previousTask, ...pendingLaunches])
          } finally {
            if (deadline) clearTimeout(deadline)
          }
        }
        // Clearing the active pointer does not release ownership of its shutdown.
        // Every later Start/Stop must join the same retiring helper.
        shutdown = Promise.all([shutdown, wait()]).then(() => {})
        await shutdown
        if (retirementFailed) throw new Error("Capture retirement failed")
        if (cleanupFailed) throw new Error("Capture reader cleanup failed")
        return token
      }

      const sourceLabel = () => {
        const current = choice()
        return !current
          ? "Not selected"
          : current.kind === "cliamp"
            ? "CLIAMP spectrum feed"
            : current.kind === "auto"
              ? "Auto: Now Playing music app"
              : `${current.kind === "kaset" ? "Kaset (WebKit)" : current.process.name} · PID ${current.process.pid}`
      }

      const chooseSource = async () => {
        if (changingSource || disposed) return
        changingSource = true
        try {
          const token = await stop()
          if (disposed || token !== generation) return
          const read = readFor(token)
          const list = (await processes(read)).filter(musicCandidate)
          if (disposed || token !== generation) return
          const selected = await waitDialog(() =>
            context.ui.dialog.select({
              title: "Local audio source — no capture until Start",
              options: [
                {
                  title: "CLIAMP exported spectrum",
                  value: "cliamp",
                  description: "Spectrum and mirror only; no OS capture",
                },
                {
                  title: "Auto: current Now Playing music app",
                  value: "auto",
                  description:
                    "Directly matched music process only; unverified helpers are refused",
                },
                {
                  title: "Kaset: attributed WebKit audio",
                  value: "kaset",
                  description:
                    "Local-tested cache association; one active helper only, no automatic rebinding",
                },
                ...list.map((entry) => ({
                  title: `${clean(entry.name)} · PID ${entry.pid}`,
                  value: String(entry.pid),
                  description: `Native: all output from this process · ${clean(entry.bundle || "unbundled")}`,
                })),
              ],
            }),
          )
          if (!selected || disposed || token !== generation) return
          if (selected === "cliamp") setChoice({ kind: "cliamp" })
          else if (selected === "auto") setChoice({ kind: "auto" })
          else if (selected === "kaset") {
            setChoice(null)
            const process = await kasetSource(read)
            if (disposed || token !== generation) return
            setChoice({ kind: "kaset", process })
          } else {
            const process = list.find((entry) => String(entry.pid) === selected)
            if (process) setChoice({ kind: "native", process })
          }
          setStatus("Source selected; capture is off")
        } finally {
          changingSource = false
        }
      }

      const chooseStyle = async () => {
        if (disposed) return
        const selected = await waitDialog(() =>
          context.ui.dialog.select({
            title: "Local visualization style",
            current: style(),
            options: styles.map((value) => ({
              title: value,
              value,
              ...(value === "scope"
                ? {
                    description:
                      "Signed trace; amplitude envelope in one-row layout",
                  }
                : {}),
              disabled:
                choice()?.kind === "cliamp" &&
                (value === "scope" || value === "meters"),
            })),
          }),
        )
        if (selected && !disposed) setStyle(selected)
      }

      const start = async () => {
        if (disposed) return
        if (changingSource)
          throw new Error("Finish source selection before starting capture")
        const token = await stop()
        if (disposed || changingSource || token !== generation) return
        const read = readFor(token)
        const selected = choice()
        if (!selected) throw new Error("Choose a source first")
        let source: ProcessSource | null = null
        if (selected.kind !== "cliamp") {
          source =
            selected.kind === "auto" ? await automatic(read) : selected.process
          if (disposed || token !== generation) return
          const current = (await processes(read)).find(
            (entry) =>
              entry.pid === source!.pid &&
              entry.object === source!.object &&
              entry.bundle === source!.bundle &&
              entry.name === source!.name,
          )
          if (!current)
            throw new Error(
              "Selected process identity changed; choose it again",
            )
          if (selected.kind === "kaset")
            await requireKasetAttribution(current, read)
          if (disposed || token !== generation) return
          const name =
            selected.kind === "kaset" ? "Kaset (WebKit)" : source.name
          const allowed = await waitDialog(() =>
            context.ui.dialog.confirm({
              title: "Capture selected process for 30 seconds?",
              message: `${clean(name)} · PID ${current.pid}\nAll output from this process, not one song/tab. No microphone, saved audio, or uploads. macOS may request system-audio access.`,
            }),
          )
          if (!allowed || disposed || token !== generation) return
          if (selected.kind === "auto") {
            const nowPlaying = await automatic(read)
            if (disposed || token !== generation) return
            if (
              nowPlaying.pid !== source.pid ||
              nowPlaying.object !== source.object ||
              nowPlaying.bundle !== source.bundle
            )
              throw new Error(
                "Now Playing source changed while confirmation was open; start again",
              )
          }
          const stillCurrent = (await processes(read)).find(
            (entry) =>
              entry.pid === source!.pid &&
              entry.object === source!.object &&
              entry.bundle === source!.bundle &&
              entry.name === source!.name,
          )
          if (!stillCurrent)
            throw new Error(
              "Selected process changed while confirmation was open; choose it again",
            )
          if (selected.kind === "kaset")
            await requireKasetAttribution(stillCurrent, read)
        }
        if (disposed || token !== generation) return
        // Stop/disposal can reenter spawn before the returned child is published.
        let finishLaunch!: () => void
        const launch = new Promise<void>((resolve) => {
          finishLaunch = resolve
        })
        launches.add(launch)
        try {
          let input: CaptureChild
          try {
            input = spawn(
              source
                ? [
                    helper,
                    "--pid",
                    String(source.pid),
                    "--seconds",
                    "30",
                    "--object",
                    String(source.object),
                  ]
                : ["cliamp", "visstream", "--fps", "20"],
            )
          } catch {
            throw new Error("Capture process could not start")
          }
          // Let queued Stop/source actions invalidate the epoch before publication.
          await Promise.resolve()
          if (disposed || token !== generation) {
            try {
              await retireCapture(input)
            } catch {
              retirementFailed = true
              throw new Error("Capture retirement failed")
            }
            return
          }
          child = input
          setRunning(true)
          const name = source
            ? selected.kind === "kaset"
              ? "Kaset (WebKit)"
              : source.name
            : "CLIAMP"
          setStatus(
            source
              ? `Capturing ${clean(name)} · 30s limit`
              : "Receiving CLIAMP spectrum · 30s limit",
          )
          let received = 0
          let expired = false
          const completion = input.exited.then(
            (code) => ({ code, failed: false }),
            () => ({ code: 1, failed: true }),
          )
          const deadline = setTimeout(() => {
            expired = true
            input.kill("SIGTERM")
          }, 31_000)
          const readers = new AbortController()
          cancelReaders = () => readers.abort()
          const hardDeadline = setTimeout(() => {
            input.kill("SIGKILL")
            readers.abort()
          }, 33_000)
          let diagnosticsFailed = false
          const diagnostics = drainDiagnostics(
            input.stderr,
            readers.signal,
          ).catch((error: unknown) => {
            if (error instanceof ReaderCleanupError) cleanupFailed = true
            diagnosticsFailed = true
            input.kill("SIGTERM")
          })
          let metadataPending = false
          const metadataWatch =
            selected.kind === "auto" && source
              ? setInterval(() => {
                  if (metadataPending || disposed || token !== generation)
                    return
                  metadataPending = true
                  action(async () => {
                    try {
                      const metadata = await read([
                        "media-control",
                        "get",
                        "--no-artwork",
                        "--now",
                      ])
                      if (disposed || token !== generation) return
                      if (
                        !object(metadata) ||
                        metadata.processIdentifier !== source!.pid ||
                        (metadata.parentApplicationBundleIdentifier ||
                          metadata.bundleIdentifier) !== source!.bundle
                      )
                        await stop(
                          "Now Playing source changed; capture stopped",
                        )
                    } catch {
                      if (!disposed && token === generation)
                        await stop(
                          "Now Playing ownership unavailable; capture stopped",
                        )
                    } finally {
                      metadataPending = false
                    }
                  })
                }, 1_000)
              : undefined
          const consume = (async () => {
            try {
              await consumeFeatureLines(
                input.stdout,
                (line) => {
                  const event: unknown = JSON.parse(line)
                  if (disposed || token !== generation) return
                  const next = frame(event)
                  if (next) {
                    received++
                    setSignal(next)
                    setLastFrame(Date.now())
                    if (received === 1)
                      setStatus(
                        source
                          ? `Capturing ${clean(name)} · 30s limit`
                          : `CLIAMP spectrum (${clean(next.visualizer ?? "unknown")}) · 30s limit`,
                      )
                  } else if (object(event)) {
                    setSignal(null)
                    if (event.type === "error" || event.ok === false)
                      throw new Error("Source reported a capture failure")
                    if (event.state) setStatus("Source has no feature frame")
                    else if (event.visualizer)
                      setStatus("Unsupported CLIAMP mode")
                  }
                },
                readers.signal,
              )
              const exit = await completion
              await diagnostics
              if (diagnosticsFailed)
                throw new Error("Source diagnostics could not be drained")
              if (exit.failed)
                throw new Error("Capture process exit could not be read")
              if (exit.code !== 0 && !expired && token === generation)
                throw new Error(`Capture process exited with code ${exit.code}`)
              if (!disposed && token === generation)
                setStatus(
                  `Ended · ${received} feature frames · Start to repeat`,
                )
            } finally {
              input.kill("SIGTERM")
              readers.abort()
              const cleanup = setTimeout(() => input.kill("SIGKILL"), 1_000)
              try {
                await Promise.allSettled([completion, diagnostics])
              } finally {
                clearTimeout(cleanup)
                clearTimeout(deadline)
                clearTimeout(hardDeadline)
                if (metadataWatch) clearInterval(metadataWatch)
              }
              if (!disposed && token === generation) {
                child = null
                cancelReaders = null
                setRunning(false)
                setSignal(null)
              }
            }
          })()
          const ownedTask = consume.catch((error: unknown) => {
            if (error instanceof ReaderCleanupError) cleanupFailed = true
            if (!disposed && token === generation) failure(error)
          })
          task = ownedTask
          // Reader acquisition can reenter Stop before this task pointer exists.
          // Keep the launch reservation until that retiring work actually joins.
          if (disposed || token !== generation) {
            await ownedTask
            if (task === ownedTask) task = null
          }
        } finally {
          launches.delete(launch)
          finishLaunch()
        }
      }

      // The plugin owns pending UI actions and capture work; errors stay visible.
      const action = (fn: () => Promise<unknown>) => {
        void command(fn)().catch(() => {})
      }
      const command = (fn: () => Promise<unknown>) => () => {
        if (disposed) return Promise.resolve()
        // Register before execution, including reentrant disposal from a host call.
        const owned = Promise.resolve()
          .then(() => (disposed ? undefined : fn()))
          .then(() => {}, failure)
        actions.add(owned)
        void owned.then(
          () => actions.delete(owned),
          () => actions.delete(owned),
        )
        return owned
      }
      const unregister = context.ui.slot({
        append: "sidebar.content",
        render: () => {
          const rows = createMemo(() => {
            clock()
            return context.renderer.terminalHeight >= 60
              ? 6
              : context.renderer.terminalHeight >= 42
                ? 4
                : 1
          })
          const lines = createMemo(() => {
            clock()
            const current = signal()
            return current && clock() - lastFrame() < 500
              ? render(current, style(), 24, rows()).join("\n")
              : "No fresh signal"
          })
          return (
            <box
              border={["top"]}
              borderColor={context.theme.border.base}
              padding={1}
              gap={1}
              flexDirection="column"
              flexShrink={0}
            >
              <text fg={context.theme.text.action.primary.base}>
                <b>REAL AUDIO · LOCAL PROTOTYPE</b>
              </text>
              <text fg={context.theme.text.muted}>{sourceLabel()}</text>
              <text fg={context.theme.text.muted}>
                {style()}
                {style() === "scope" && rows() === 1
                  ? " (envelope)"
                  : ""} · {status()}
              </text>
              <text fg={context.theme.text.action.primary.base}>{lines()}</text>
              <box flexDirection="row" gap={1}>
                <box
                  onMouseDown={(event) => {
                    if (event.button === MouseButton.LEFT) {
                      event.stopPropagation()
                      action(chooseSource)
                    }
                  }}
                >
                  <text>Source</text>
                </box>
                <box
                  onMouseDown={(event) => {
                    if (event.button === MouseButton.LEFT) {
                      event.stopPropagation()
                      action(chooseStyle)
                    }
                  }}
                >
                  <text>Style</text>
                </box>
                <box
                  onMouseDown={(event) => {
                    if (event.button === MouseButton.LEFT) {
                      event.stopPropagation()
                      action(start)
                    }
                  }}
                >
                  <text>Start</text>
                </box>
                <box
                  onMouseDown={(event) => {
                    if (event.button === MouseButton.LEFT) {
                      event.stopPropagation()
                      action(() => stop())
                    }
                  }}
                >
                  <text>Stop</text>
                </box>
              </box>
            </box>
          )
        },
      })
      // The app slot supplies OpenCode's keymap provider and owns registrations.
      const unregisterCommands = context.ui.slot({
        append: "app",
        render: () => {
          context.keymap.layer(() => ({
            mode: "global",
            commands: [
              {
                id: "audio-prototype.source",
                title: "Choose audio source",
                group: "Audio prototype",
                palette: true,
                slash: { name: "audio-source" },
                run: command(chooseSource),
              },
              {
                id: "audio-prototype.style",
                title: "Choose visualization style",
                group: "Audio prototype",
                palette: true,
                slash: { name: "audio-style" },
                run: command(chooseStyle),
              },
              {
                id: "audio-prototype.start",
                title: "Start 30-second audio preview",
                group: "Audio prototype",
                palette: true,
                slash: { name: "audio-start" },
                run: command(start),
              },
              {
                id: "audio-prototype.stop",
                title: "Stop audio preview",
                group: "Audio prototype",
                palette: true,
                slash: { name: "audio-stop" },
                run: command(() => stop()),
              },
            ],
          }))
          return null
        },
      })
      const ticker = setInterval(() => {
        if (running()) setClock(Date.now())
      }, 100)
      return async () => {
        disposed = true
        lifetime.abort()
        dialogs.cancel()
        clearInterval(ticker)
        unregister()
        unregisterCommands()
        const stopped = stop()
        const [outcome] = await Promise.allSettled([
          stopped,
          ...actions,
          ...reads,
        ])
        if (outcome?.status === "rejected" || retirementFailed || cleanupFailed)
          throw new Error("Audio prototype cleanup failed")
      }
    },
  })
}

export default createAudioPrototype()
