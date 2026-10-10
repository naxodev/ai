import type {
  AudioFeatureFrame,
  AudioSourceList,
  MusicSessionClient,
} from "@naxodev/music-core"

export const audioStyles = ["spectrum", "mirror", "scope", "meters"] as const
export type AudioStyle = (typeof audioStyles)[number]
export const isAudioStyle = (value: unknown): value is AudioStyle =>
  audioStyles.some((style) => style === value)

type SourceEntry = AudioSourceList["sources"][number]
export type AudioConnection = Pick<
  MusicSessionClient,
  | "listAudioSources"
  | "startAudioCapture"
  | "stopAudioCapture"
  | "subscribeAudioStatus"
  | "subscribeAudioFeatures"
  | "subscribeTerminal"
  | "dispose"
>
export type AudioViewState = {
  readonly selected: SourceEntry | null
  readonly style: AudioStyle
  readonly active: boolean
  readonly frame: AudioFeatureFrame | null
  readonly message: string
}

const unavailableSourceMessage = (reason: AudioSourceList["reason"]) => {
  switch (reason) {
    case "capture-adapter-unavailable":
      return "Helper off: check build"
    case "not-negotiated":
      return "Update audio daemon"
    case "unsupported":
      return "Audio unsupported"
    default:
      return "Audio unavailable"
  }
}

/** Promise-only host boundary. Selection, subscription, and style never grant capture. */
export function createAudioVisualization(options: {
  connect: () => Promise<AudioConnection>
  confirm: (source: SourceEntry) => Promise<boolean>
  cancelPendingDialogs?: () => Promise<void>
  initialStyle?: AudioStyle
}) {
  let state: AudioViewState = {
    selected: null,
    style: options.initialStyle ?? "spectrum",
    active: false,
    frame: null,
    message: "Capture off — choose a source",
  }
  const listeners = new Set<(state: AudioViewState) => void>()
  let client: AudioConnection | undefined
  let latestClient: AudioConnection | undefined
  let admission: { client: AudioConnection; generation: number } | undefined
  let selection:
    { client: AudioConnection; source: SourceEntry; epoch: number } | undefined
  let initialStatus: { client: AudioConnection; received: boolean } | undefined
  let statusWait:
    { client: AudioConnection; finish: (received: boolean) => void } | undefined
  let connecting: Promise<AudioConnection> | undefined
  let starting: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  let latestRetirement: Promise<void> | undefined
  let retiring: Promise<void> = Promise.resolve()
  let closing: Promise<void> | undefined
  let disposers: Array<() => void> = []
  let epoch = 0
  let disposed = false
  let choosing = false
  let mayOwn = false
  let uncertainStop = false
  const actions = new Set<Promise<void>>()
  const track = (action: Promise<void>) => {
    const owned = action.finally(() => actions.delete(owned))
    actions.add(owned)
    return owned
  }
  const publish = (change: Partial<AudioViewState>) => {
    if (disposed) return
    state = { ...state, ...change }
    for (const listener of listeners) listener(state)
  }
  const releaseClient = () => {
    statusWait?.finish(false)
    initialStatus = undefined
    for (const dispose of disposers) dispose()
    disposers = []
    client?.dispose()
    client = undefined
    selection = undefined
    mayOwn = false
  }
  const waitForInitialStatus = (connected: AudioConnection) => {
    if (initialStatus?.client !== connected) return Promise.resolve(false)
    if (initialStatus.received) return Promise.resolve(true)
    const pending = new Promise<boolean>((resolve) => {
      const waiting = {
        client: connected,
        finish: (received: boolean) => {
          clearTimeout(timer)
          if (statusWait === waiting) statusWait = undefined
          resolve(received)
        },
      }
      const timer = setTimeout(() => waiting.finish(false), 3000)
      statusWait = waiting
    })
    // Establish the owned wait before synchronous observers can cancel it.
    publish({ message: "Waiting for audio status" })
    return pending
  }
  const connect = async () => {
    if (disposed) throw new Error("Audio view is closed")
    if (client) return client
    connecting ??= options
      .connect()
      .then((connected) => {
        if (disposed) {
          connected.dispose()
          throw new Error("Audio view is closed")
        }
        client = connected
        latestClient = connected
        initialStatus = { client: connected, received: false }
        disposers = [
          connected.subscribeAudioStatus((status) => {
            if (disposed || client !== connected) return
            if (initialStatus?.client === connected)
              initialStatus.received = true
            if (statusWait?.client === connected) statusWait.finish(true)
            if (
              status.type === "stopped" ||
              status.type === "failed" ||
              status.type === "unavailable"
            ) {
              const ownedInterest = mayOwn
              // Retire only an existing selection's lifetime, including consent
              // still pending. A cached status on a fresh socket has no authority.
              const selectedInterest =
                selection?.client === connected &&
                selection.epoch === epoch &&
                selection.source === state.selected
              if (ownedInterest || selectedInterest) ++epoch
              selection = undefined
              mayOwn = false
              // Expiry retires this connection's audio lifetime. A fresh socket
              // cannot receive delayed status from the expired same-generation join.
              if (
                status.type === "stopped" &&
                status.reason === "lease-expired" &&
                (ownedInterest ||
                  (admission?.client === connected &&
                    admission.generation === status.generation))
              )
                releaseClient()
              publish({
                active: false,
                frame: null,
                selected: null,
                message:
                  status.type === "stopped"
                    ? `Capture off (${status.reason})`
                    : status.type === "unavailable"
                      ? unavailableSourceMessage(status.reason)
                      : `Capture unavailable (${status.reason})`,
              })
            }
          }),
          connected.subscribeAudioFeatures((update) => {
            if (disposed || client !== connected) return
            if ("type" in update) publish({ frame: null })
            else if (mayOwn) publish({ frame: update })
          }),
          connected.subscribeTerminal(() => {
            if (disposed || client !== connected) return
            ++epoch
            releaseClient()
            publish({
              selected: null,
              active: false,
              frame: null,
              message: "Disconnected — select again; capture is off",
            })
          }),
        ]
        // A retained terminal event can fire while subscriptions are registering.
        if (client !== connected) {
          for (const dispose of disposers) dispose()
          disposers = []
        }
        return connected
      })
      .finally(() => {
        connecting = undefined
      })
    return connecting
  }

  const stopUnconfirmed = (
    owned: AudioConnection | undefined,
    message: string,
  ) => {
    // Terminal notification can release the client before its Stop rejects.
    // A newer connection, however, owns a different source-selection lifetime.
    if (latestClient !== owned) return
    ++epoch
    uncertainStop = true
    if (client === owned) releaseClient()
    publish({ active: false, frame: null, selected: null, message })
  }
  const queueStop = (
    owned: AudioConnection | undefined,
    message: string,
    cancelDialogs = false,
  ) => {
    const request = retiring.then(async () => {
      try {
        if (cancelDialogs) await options.cancelPendingDialogs?.()
        const result = owned ? await owned.stopAudioCapture() : undefined
        if (result?.type === "rejected")
          stopUnconfirmed(owned, "Not joined — shared Stop not confirmed")
        else if (!uncertainStop) publish({ message })
      } catch (error) {
        // An uncertain Stop cannot retain this window's capture interest.
        stopUnconfirmed(owned, "Stop unconfirmed — disconnected; select again")
        throw error
      }
    })
    const pending = request.finally(() => {
      if (stopping === pending) stopping = undefined
      if (latestRetirement === pending) latestRetirement = undefined
    })
    latestRetirement = pending
    // The initiating caller reports the failure; future selection may recover.
    retiring = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }
  const stop = (message = "Capture off") => {
    if (stopping) return stopping
    if (latestRetirement) return latestRetirement
    ++epoch
    const owned = mayOwn ? client : undefined
    mayOwn = false
    selection = undefined
    statusWait?.finish(false)
    // Observers can synchronously call Stop from publication. Establish the
    // exact shared outcome before notifying them or exposing cleared authority.
    stopping = queueStop(owned, message, actions.size > 0)
    publish({
      active: false,
      frame: null,
      selected: null,
      message: owned
        ? "Stopping shared capture"
        : uncertainStop
          ? state.message
          : message,
    })
    // Concurrent callers share the exact outcome, including an unconfirmed Stop.
    return stopping
  }

  const chooseSource = async (
    choose: (list: AudioSourceList) => Promise<SourceEntry | undefined>,
  ) => {
    if (disposed || choosing) return
    choosing = true
    try {
      await stop()
      // A late admission may have queued cleanup behind the normal Stop.
      // Join the latest barrier before discovery, not just before accepting it.
      let barrier: Promise<void>
      do {
        barrier = retiring
        await barrier
      } while (retiring !== barrier)
      const ticket = epoch
      const connected = await connect()
      if (
        disposed ||
        ticket !== epoch ||
        client !== connected ||
        retiring !== barrier
      )
        return
      const list = await connected.listAudioSources()
      if (
        disposed ||
        ticket !== epoch ||
        client !== connected ||
        retiring !== barrier
      )
        return
      if (list.availability !== "available" || list.sources.length === 0) {
        publish({
          selected: null,
          message:
            list.availability === "available"
              ? "No unambiguous active Kaset source; capture is off"
              : unavailableSourceMessage(list.reason),
        })
        return
      }
      const ready = await waitForInitialStatus(connected)
      if (
        disposed ||
        ticket !== epoch ||
        client !== connected ||
        retiring !== barrier
      )
        return
      if (!ready) {
        ++epoch
        releaseClient()
        publish({
          selected: null,
          message: "Status timeout: retry",
        })
        return
      }
      const selected = await choose(list)
      if (
        disposed ||
        ticket !== epoch ||
        client !== connected ||
        retiring !== barrier
      )
        return
      // Only the daemon-issued entries shown in this exact dialog are usable.
      const canonical =
        selected &&
        list.sources.find((source) => source.token === selected.token)
      if (canonical) {
        uncertainStop = false
        selection = { client: connected, source: canonical, epoch: ticket }
        publish({
          selected: canonical,
          frame: null,
          message: "Source selected; capture is off",
        })
      }
    } finally {
      choosing = false
    }
  }

  const start = (): Promise<void> => {
    if (disposed || choosing) return Promise.resolve()
    if (starting) return starting
    const selected = state.selected
    if (!selected)
      return Promise.reject(new Error("Choose a fresh source first"))
    if (state.active) return Promise.resolve()
    const ticket = epoch
    const lifetime = selection
    const currentSelection = () =>
      lifetime !== undefined &&
      selection === lifetime &&
      lifetime.epoch === epoch &&
      lifetime.client === client &&
      lifetime.source === state.selected
    starting = (async () => {
      await retiring
      if (disposed || ticket !== epoch || !currentSelection()) return
      if (!(await options.confirm(selected))) return
      if (disposed || ticket !== epoch || !currentSelection()) return
      const connected = await connect()
      if (
        disposed ||
        ticket !== epoch ||
        client !== connected ||
        !currentSelection()
      )
        return
      mayOwn = true
      publish({ frame: null, message: "Starting selected capture" })
      // Publication can synchronously revoke consent before any capture request.
      if (
        disposed ||
        ticket !== epoch ||
        client !== connected ||
        !mayOwn ||
        !currentSelection()
      ) {
        mayOwn = false
        return
      }
      const result = await connected.startAudioCapture(selected.token)
      if (
        (result.type === "started" || result.type === "joined") &&
        latestClient === connected
      )
        admission = {
          client: connected,
          generation:
            admission?.client === connected
              ? Math.max(admission.generation, result.generation)
              : result.generation,
        }
      if (disposed || ticket !== epoch || client !== connected) {
        // Stop may have arrived before daemon admission. Retire this late result.
        if (
          !disposed &&
          client === connected &&
          (result.type === "started" || result.type === "joined")
        ) {
          const cleanup = queueStop(connected, "Capture off")
          publish({
            selected: null,
            active: false,
            frame: null,
            message: "Retiring late capture admission",
          })
          await cleanup
        }
        return
      }
      if (result.type === "started" || result.type === "joined")
        publish({
          active: true,
          message:
            result.type === "joined"
              ? "Joined shared capture"
              : "Capturing selected process",
        })
      else {
        mayOwn = false
        publish({
          active: false,
          frame: null,
          selected: null,
          message:
            result.type === "busy"
              ? "Another source is active; capture not joined"
              : `Capture not started (${result.reason}); select again`,
        })
      }
    })()
      .catch((error: unknown) => {
        if (!disposed && ticket === epoch) {
          ++epoch
          releaseClient()
          publish({
            selected: null,
            active: false,
            frame: null,
            message: "Capture failed — select again; capture is off",
          })
        }
        throw error
      })
      .finally(() => {
        starting = undefined
      })
    return starting
  }

  return {
    current: () => state,
    subscribe(listener: (state: AudioViewState) => void) {
      listeners.add(listener)
      listener(state)
      return () => {
        listeners.delete(listener)
      }
    },
    chooseSource: (choose: Parameters<typeof chooseSource>[0]) =>
      track(Promise.resolve().then(() => chooseSource(choose))),
    start: () => {
      if (starting) return starting
      const action = start()
      // Keep concurrent Start calls on the same owned promise.
      if (starting) starting = track(action)
      return starting ?? action
    },
    stop,
    setStyle(style: AudioStyle) {
      publish({ style })
    },
    dispose() {
      if (closing) return closing
      disposed = true
      ++epoch
      statusWait?.finish(false)
      const pending = [...actions]
      closing = Promise.resolve().then(async () => {
        releaseClient()
        listeners.clear()
        // Disconnect releases only this window's interest. Never Stop another window.
        try {
          await options.cancelPendingDialogs?.()
        } finally {
          // Callers own action errors. Disposal owns their completion, including
          // requests rejected by disconnect and dialogs canceled by the host.
          await Promise.allSettled(pending)
          await retiring
        }
      })
      return closing
    },
  }
}

const clamp = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
const glyphs = " ▁▂▃▄▅▆▇█"
export function renderAudioFeatures(
  frame: AudioFeatureFrame | null,
  style: AudioStyle,
  width: number,
  rows: number,
): string[] {
  width = Number.isFinite(width)
    ? Math.max(1, Math.min(120, Math.floor(width)))
    : 1
  rows = rows >= 6 ? 6 : rows >= 4 ? 4 : 1
  if (!frame) return ["No fresh signal".slice(0, width)]
  if (style === "meters") {
    if (!frame.channels || frame.channels.layout !== "stereo")
      return ["Stereo unavailable".slice(0, width)]
    const meter = (channel: number, size: number, labels: boolean) => {
      const rms = frame.channels?.rms[channel] ?? 0
      const db = 20 * Math.log10(Math.max(0.000001, rms))
      const label = labels ? ` ${db.toFixed(1)} dBFS` : ""
      const available = Math.max(0, size - 1 - label.length)
      const filled = Math.round(clamp((db + 60) / 60) * available)
      const cells: string[] = Array.from({ length: available }, (_, index) =>
        index < filled ? "█" : "░",
      )
      const peak = frame.channels?.peaks[channel] ?? 0
      if (peak > 0 && available > 0) {
        const dbPeak = 20 * Math.log10(Math.max(0.000001, peak))
        const index = Math.min(
          available - 1,
          Math.round(clamp((dbPeak + 60) / 60) * available),
        )
        cells[index] = "│"
      }
      return `${channel ? "R" : "L"}${cells.join("")}${label}`.slice(0, size)
    }
    if (rows === 1) {
      if (width < 3) return ["LR".slice(0, width)]
      const left = Math.floor((width - 1) / 2)
      return [`${meter(0, left, false)} ${meter(1, width - left - 1, false)}`]
    }
    return [meter(0, width, width >= 15), meter(1, width, width >= 15)]
  }
  if (style === "scope") {
    if (!frame.envelope?.length) return ["Envelope unavailable".slice(0, width)]
    const buckets = Array.from(
      { length: width },
      (_, x) =>
        frame.envelope?.[
          Math.floor((x * (frame.envelope?.length ?? 0)) / width)
        ],
    )
    if (rows === 1)
      return [
        buckets
          .map(
            (bucket) =>
              glyphs[
                Math.round(
                  clamp(
                    Math.max(
                      Math.abs(bucket?.min ?? 0),
                      Math.abs(bucket?.max ?? 0),
                    ),
                  ) * 8,
                )
              ],
          )
          .join(""),
      ]
    return Array.from({ length: rows }, (_, y) =>
      buckets
        .map((bucket) => {
          const high = Math.round(
            ((1 - Math.max(-1, Math.min(1, bucket?.max ?? 0))) * (rows - 1)) /
              2,
          )
          const low = Math.round(
            ((1 - Math.max(-1, Math.min(1, bucket?.min ?? 0))) * (rows - 1)) /
              2,
          )
          return y >= high && y <= low
            ? "│"
            : y === Math.floor(rows / 2)
              ? "─"
              : " "
        })
        .join(""),
    )
  }
  if (!frame.spectrum.length) return ["Spectrum unavailable".slice(0, width)]
  const bands = Array.from({ length: width }, (_, x) =>
    clamp(frame.spectrum[Math.floor((x * frame.spectrum.length) / width)] ?? 0),
  )
  if (rows === 1)
    return [bands.map((value) => glyphs[Math.round(value * 8)]).join("")]
  return Array.from({ length: rows }, (_, y) =>
    bands
      .map((value) => {
        const threshold =
          style === "mirror"
            ? (Math.abs(y - (rows - 1) / 2) + 0.5) / (rows / 2)
            : (rows - y) / rows
        return value > 0 && value >= threshold ? "█" : " "
      })
      .join(""),
  )
}
