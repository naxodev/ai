import { expect, test } from "bun:test"
import { MusicSessionClientError } from "@naxodev/music-core"
import type {
  AudioCaptureStatus,
  AudioFeatureFrame,
  AudioSourceList,
  AudioStartResult,
} from "@naxodev/music-core"
import {
  audioStyles,
  createAudioVisualization,
  renderAudioFeatures,
  type AudioConnection,
} from "../audio-visualization.ts"
import { createAudioDialogWaits } from "../audio-dialogs.ts"

function deferred<A>() {
  let resolve: (value: A) => void = () => {}
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const selected: AudioSourceList["sources"][number] = {
  token: "selected-token",
  label: "Kaset (WebKit) · PID 42",
  mode: "process",
  capabilities: {
    spectrum: "measured",
    envelope: "measured",
    channels: "stereo",
  },
}
const frame: AudioFeatureFrame = {
  daemonInstanceId: "fixture",
  generation: 1,
  sequence: 1,
  timestampMs: 100,
  publishedAtMs: 100,
  sampleAgeMs: 0,
  clockDomain: "capture-monotonic",
  source: {
    kind: "native",
    processIdentifier: 42,
    launchIdentity: "100:0",
    executableIdentity: "player",
    coreAudioObject: "99",
  },
  capabilities: selected.capabilities,
  spectrum: [0.8, 0.3],
  envelope: [{ min: -0.5, max: 0.5 }],
  channels: { layout: "stereo", rms: [0.2, 0.1], peaks: [0.4, 0.2] },
}
function connection(baseline: AudioCaptureStatus | null = { type: "idle" }) {
  const status = new Set<(value: AudioCaptureStatus) => void>()
  const features = new Set<
    Parameters<AudioConnection["subscribeAudioFeatures"]>[0]
  >()
  const terminal = new Set<(error: MusicSessionClientError) => void>()
  const events: string[] = []
  const client: AudioConnection = {
    listAudioSources: async () => {
      events.push("list")
      return { availability: "available", sources: [selected] }
    },
    startAudioCapture: async () => {
      events.push("start")
      return { type: "started", generation: 1, source: frame.source }
    },
    stopAudioCapture: async () => {
      events.push("stop")
      return { type: "stopped", generation: 1, reason: "stop" }
    },
    subscribeAudioStatus: (listener) => {
      status.add(listener)
      if (baseline) listener(baseline)
      return () => {
        status.delete(listener)
      }
    },
    subscribeAudioFeatures: (listener) => {
      features.add(listener)
      return () => {
        features.delete(listener)
      }
    },
    subscribeTerminal: (listener) => {
      terminal.add(listener)
      return () => {
        terminal.delete(listener)
      }
    },
    dispose: () => {
      events.push("dispose")
    },
  }
  return { client, events, status, features, terminal }
}
const select = (model: ReturnType<typeof createAudioVisualization>) =>
  model.chooseSource(async (list) => list.sources[0])

test("mount, style, and source selection never start capture; declined consent has no authority", async () => {
  const fake = connection()
  const model = createAudioVisualization({
    connect: async () => fake.client,
    confirm: async () => false,
  })
  try {
    expect(fake.events).toEqual([])
    for (const style of audioStyles) model.setStyle(style)
    expect(fake.events).toEqual([])
    await select(model)
    await model.start()
    expect(fake.events).toEqual(["list"])
    expect(model.current().active).toBe(false)
  } finally {
    await model.dispose()
  }
})

for (const { name, list, message } of [
  {
    name: "an available empty catalog",
    list: { availability: "available", sources: [] },
    message: "No unambiguous active Kaset source; capture is off",
  },
  {
    name: "an unavailable helper",
    list: {
      availability: "unavailable",
      reason: "capture-adapter-unavailable",
      sources: [],
    },
    message: "Helper off: check build",
  },
  {
    name: "capture not negotiated",
    list: {
      availability: "unavailable",
      reason: "not-negotiated",
      sources: [],
    },
    message: "Update audio daemon",
  },
  {
    name: "unsupported capture",
    list: { availability: "unavailable", reason: "unsupported", sources: [] },
    message: "Audio unsupported",
  },
  {
    name: "unavailable capture without a reason",
    list: { availability: "unavailable", sources: [] },
    message: "Audio unavailable",
  },
] satisfies readonly {
  name: string
  list: AudioSourceList
  message: string
}[]) {
  test(`${name} reports its fixed availability message without offering a source or starting capture`, async () => {
    // Empty/unavailable discovery must settle even without an initial status.
    const fake = connection(null)
    fake.client.listAudioSources = async () => list
    let dialogs = 0
    const model = createAudioVisualization({
      connect: async () => fake.client,
      confirm: async () => true,
    })
    try {
      await model.chooseSource(async () => {
        dialogs++
        return selected
      })
      expect(model.current().message).toBe(message)
      expect(model.current().selected).toBeNull()
      expect(dialogs).toBe(0)
      expect(fake.events).not.toContain("start")
    } finally {
      await model.dispose()
    }
  })
}

test("unavailable discovery never displays raw reasons or private source metadata", async () => {
  const fake = connection()
  fake.client.listAudioSources = async () =>
    ({
      availability: "unavailable",
      reason: "private song title\u001b[31m",
      sources: [{ ...selected, label: "private artist and track" }],
    }) as unknown as AudioSourceList
  const model = createAudioVisualization({
    connect: async () => fake.client,
    confirm: async () => true,
  })
  try {
    await select(model)
    expect(model.current().message).toBe("Audio unavailable")
    expect(model.current().selected).toBeNull()
    expect(fake.events).not.toContain("start")
  } finally {
    await model.dispose()
  }
})

test("disposal from a synchronous selection notification joins the action before closing", async () => {
  const fake = connection()
  const events: string[] = []
  let closing: Promise<void> | undefined
  let armed = false
  const model = createAudioVisualization({
    connect: async () => {
      events.push("connect")
      return fake.client
    },
    confirm: async () => true,
  })
  model.subscribe((state) => {
    if (armed && state.message === "Capture off") {
      armed = false
      closing = model.dispose().then(() => {
        events.push("disposed")
      })
    }
  })
  armed = true
  const selection = select(model)
  const settled = selection.then(
    () => events.push("selection settled"),
    () => events.push("selection settled"),
  )
  try {
    // Deferred execution may publish on the next microtask, but ownership must
    // already exist when the synchronous subscriber requests disposal.
    await Promise.resolve()
    expect(closing).toBeDefined()
    await closing
    expect(events).toEqual(["selection settled", "disposed"])
    expect(fake.events).toEqual([])
  } finally {
    await model.dispose()
    await settled
  }
})

test("concurrent Starts share one confirmation; style changes reuse the selected capture", async () => {
  const fake = connection()
  const consent = deferred<boolean>()
  let confirmations = 0
  const model = createAudioVisualization({
    connect: async () => fake.client,
    confirm: () => {
      confirmations++
      return consent.promise
    },
  })
  const actions: Promise<void>[] = []
  try {
    await select(model)
    const first = model.start()
    const second = model.start()
    actions.push(first, second)
    expect(first).toBe(second)
    await Promise.resolve()
    consent.resolve(true)
    await first
    for (const listener of fake.features) listener(frame)
    for (const style of audioStyles) model.setStyle(style)
    expect(confirmations).toBe(1)
    expect(fake.events).toEqual(["list", "start"])
    expect(model.current().frame).toEqual(frame)
    expect(model.current().active).toBe(true)
    for (const listener of fake.features)
      listener({ type: "clear", reason: "stale", generation: 1, sequence: 2 })
    expect(model.current().frame).toBeNull()
    expect(
      renderAudioFeatures(model.current().frame, "spectrum", 24, 6),
    ).toEqual(["No fresh signal"])
  } finally {
    consent.resolve(false)
    await model.dispose()
    await Promise.allSettled(actions)
  }
  expect(fake.events.at(-1)).toBe("dispose")
  expect(fake.events).not.toContain("stop")
  expect(fake.features.size).toBe(0)
})

for (const cancellation of ["stop", "dispose"] as const) {
  test(`a synchronous ${cancellation} observer prevents the Start request, not just late admission`, async () => {
    const fake = connection()
    const model = createAudioVisualization({
      connect: async () => fake.client,
      confirm: async () => true,
    })
    let canceled: Promise<void> | undefined
    const remove = model.subscribe((state) => {
      if (state.message === "Starting selected capture")
        canceled = model[cancellation]()
    })
    try {
      await select(model)
      await model.start()
      await canceled
      expect(canceled).toBeDefined()
      expect(fake.events).not.toContain("start")
      expect(model.current().active).toBe(false)
      if (cancellation === "stop") {
        expect(model.current().selected).toBeNull()
        const stops = fake.events.filter((event) => event === "stop").length
        await model.stop()
        expect(fake.events.filter((event) => event === "stop")).toHaveLength(
          stops,
        )
      }
    } finally {
      remove()
      await model.dispose()
      await canceled
    }
  })
}

test("Stop during confirmation fences later approval and requires a new selection", async () => {
  const fake = connection()
  const consent = deferred<boolean>()
  const model = createAudioVisualization({
    connect: async () => fake.client,
    confirm: () => consent.promise,
  })
  let action: Promise<void> | undefined
  try {
    await select(model)
    const start = model.start()
    action = start
    await Promise.resolve()
    await model.stop()
    consent.resolve(true)
    await start
    expect(fake.events).not.toContain("start")
    await expect(model.start()).rejects.toThrow("fresh source")
  } finally {
    consent.resolve(false)
    await model.dispose()
    await action
  }
})

for (const status of [
  { type: "stopped", generation: 1, reason: "stop" },
  { type: "failed", generation: 1, reason: "setup" },
  { type: "unavailable", reason: "capture-adapter-unavailable" },
] as const satisfies readonly AudioCaptureStatus[]) {
  test(`${status.type} shared status after the idle baseline retires pending confirmation before late approval can start capture`, async () => {
    const fake = connection()
    const entered = deferred<void>()
    const approval = deferred<boolean>()
    const model = createAudioVisualization({
      connect: async () => fake.client,
      confirm: () => {
        entered.resolve()
        return approval.promise
      },
    })
    let action: Promise<void> | undefined
    try {
      await select(model)
      action = model.start()
      await entered.promise
      for (const listener of fake.status) listener(status)
      expect(model.current().selected).toBeNull()
      const retiredMessage = model.current().message
      approval.resolve(true)
      await action
      expect(fake.events).toEqual(["list"])
      expect(model.current().active).toBe(false)
      expect(model.current().message).toBe(retiredMessage)
      await expect(model.start()).rejects.toThrow("fresh source")
    } finally {
      approval.resolve(false)
      await model.dispose()
      await action
    }
  })
}

for (const baseline of [
  { type: "stopped", generation: 1, reason: "stop" },
  { type: "unavailable", reason: "capture-adapter-unavailable" },
] as const satisfies readonly AudioCaptureStatus[]) {
  test(`delayed initial ${baseline.type} status settles before fresh selection and cannot revoke its later consent`, async () => {
    const fake = connection(null)
    const listed = deferred<void>()
    fake.client.listAudioSources = async () => {
      fake.events.push("list")
      listed.resolve()
      return { availability: "available", sources: [selected] }
    }
    let confirmations = 0
    const model = createAudioVisualization({
      connect: async () => fake.client,
      confirm: async () => {
        confirmations++
        return true
      },
    })
    const action = select(model)
    let completed = false
    const settled = action.then(() => {
      completed = true
    })
    try {
      await listed.promise
      // Drain the already-resolved catalog and selection promises, without
      // supplying the initial status. Discovery must not grant fresh authority.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(completed).toBe(false)
      expect(model.current().selected).toBeNull()
      expect(fake.events).toEqual(["list"])
      for (const listener of fake.status) listener(baseline)
      await action
      expect(model.current().selected).toEqual(selected)
      expect(confirmations).toBe(0)
      expect(fake.events).toEqual(["list"])
      await model.start()
      expect(confirmations).toBe(1)
      expect(model.current().active).toBe(true)
      expect(fake.events).toEqual(["list", "start"])
    } finally {
      await model.dispose()
      await settled
    }
  })
}

for (const cancellation of ["stop", "dispose", "disconnect"] as const) {
  test(`${cancellation} settles an owned initial-status wait without requiring a status or dialog cancellation`, async () => {
    const fake = connection(null)
    const waiting = deferred<void>()
    let dialogs = 0
    const model = createAudioVisualization({
      connect: async () => fake.client,
      confirm: async () => true,
    })
    const remove = model.subscribe((state) => {
      if (state.message === "Waiting for audio status") waiting.resolve()
    })
    const action = model.chooseSource(async (list) => {
      dialogs++
      return list.sources[0]
    })
    let completed = false
    const settled = action.then(() => {
      completed = true
    })
    try {
      await waiting.promise
      let closing: Promise<void> | undefined
      if (cancellation === "disconnect") {
        for (const listener of fake.terminal)
          listener(
            new MusicSessionClientError({
              code: "CONNECTION_LOST",
              message: "fixture closed before initial status",
              retryable: true,
            }),
          )
      } else closing = model[cancellation]()
      // Cancellation must settle now, not succeed three seconds later because
      // the readiness timeout finally released the action.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(completed).toBe(true)
      await closing
      await action
      expect(dialogs).toBe(0)
      expect(model.current().selected).toBeNull()
      expect(fake.events).not.toContain("start")
      if (cancellation === "stop") {
        // Stop cancels this action's wait, not the socket's future baseline.
        for (const listener of fake.status) listener({ type: "idle" })
        await select(model)
        await model.start()
        expect(model.current().active).toBe(true)
      } else {
        expect(fake.events).toEqual(["list", "dispose"])
        expect(fake.status.size).toBe(0)
      }
    } finally {
      remove()
      await model.dispose()
      await settled
    }
  })
}

test("missing initial status times out, releases the connection, and permits fresh selection on a healthy socket", async () => {
  const first = connection(null)
  const second = connection()
  let connections = 0
  let dialogs = 0
  const model = createAudioVisualization({
    connect: async () => (++connections === 1 ? first.client : second.client),
    confirm: async () => true,
  })
  try {
    await model.chooseSource(async (list) => {
      dialogs++
      return list.sources[0]
    })
    expect(model.current().message).toBe("Status timeout: retry")
    expect(model.current().selected).toBeNull()
    expect(dialogs).toBe(0)
    expect(first.events).toEqual(["list", "dispose"])
    await select(model)
    expect(model.current().selected).toEqual(selected)
    await model.start()
    expect(second.events).toEqual(["list", "start"])
  } finally {
    await model.dispose()
  }
}, 10_000)

test("initial cached stopped status has no selection lifetime to retire and fresh selection remains usable", async () => {
  const fake = connection()
  const subscribe = fake.client.subscribeAudioStatus
  fake.client.subscribeAudioStatus = (listener) => {
    listener({ type: "stopped", generation: 1, reason: "stop" })
    return subscribe(listener)
  }
  const model = createAudioVisualization({
    connect: async () => fake.client,
    confirm: async () => true,
  })
  try {
    await select(model)
    expect(model.current().selected).toEqual(selected)
    expect(fake.events).toEqual(["list"])
    await model.start()
    expect(fake.events).toEqual(["list", "start"])
    expect(model.current().active).toBe(true)
  } finally {
    await model.dispose()
  }
})

test("Stop retires late Start admission, and blocked shutdown fences later source selection", async () => {
  const fake = connection()
  const admitted = deferred<AudioStartResult>()
  const entering = deferred<void>()
  const releaseStop = deferred<void>()
  fake.client.startAudioCapture = async () => {
    fake.events.push("start")
    entering.resolve()
    return admitted.promise
  }
  fake.client.stopAudioCapture = async () => {
    fake.events.push("stop")
    await releaseStop.promise
    return { type: "stopped", generation: 1, reason: "stop" }
  }
  const model = createAudioVisualization({
    connect: async () => fake.client,
    confirm: async () => true,
  })
  const actions: Promise<void>[] = []
  try {
    await select(model)
    const start = model.start()
    actions.push(start)
    await entering.promise
    const stop = model.stop()
    const choosing = select(model)
    actions.push(stop, choosing)
    await Promise.resolve()
    expect(fake.events.filter((event) => event === "list")).toHaveLength(1)
    releaseStop.resolve()
    await stop
    admitted.resolve({ type: "started", generation: 1, source: frame.source })
    await Promise.all([start, choosing])
    expect(
      fake.events.filter((event) => event === "stop").length,
    ).toBeGreaterThanOrEqual(2)
    expect(model.current().active).toBe(false)
  } finally {
    releaseStop.resolve()
    admitted.resolve({ type: "busy" })
    await model.dispose()
    await Promise.allSettled(actions)
  }
})

test("a rejected Stop releases uncertain interest and allows fresh selection on a new connection", async () => {
  const first = connection()
  const second = connection()
  first.client.stopAudioCapture = async () => {
    throw new Error("Stop denied")
  }
  let connections = 0
  const model = createAudioVisualization({
    connect: async () => (++connections === 1 ? first.client : second.client),
    confirm: async () => true,
  })
  try {
    await select(model)
    await model.start()
    await expect(model.stop()).rejects.toThrow("Stop denied")
    expect(first.events.at(-1)).toBe("dispose")
    expect(first.features.size).toBe(0)
    expect(model.current().message).toContain("Stop unconfirmed")
    expect(model.current().selected).toBeNull()
    await select(model)
    expect(connections).toBe(2)
    expect(second.events).toEqual(["list"])
    await model.start()
    expect(second.events).toEqual(["list", "start"])
  } finally {
    await model.dispose()
  }
})

test("not-joined Stop cannot claim shared capture ended and drops the stale connection", async () => {
  const fake = connection()
  fake.client.stopAudioCapture = async () => ({
    type: "rejected",
    reason: "not-joined",
  })
  const model = createAudioVisualization({
    connect: async () => fake.client,
    confirm: async () => true,
  })
  try {
    await select(model)
    await model.start()
    await model.stop()
    expect(model.current().message).toBe(
      "Not joined — shared Stop not confirmed",
    )
    expect(fake.events.at(-1)).toBe("dispose")
  } finally {
    await model.dispose()
  }
})

for (const failure of ["request", "not-joined"] as const) {
  test(`concurrent Stops share ${failure} failure and a later unjoined Stop cannot hide it`, async () => {
    const fake = connection()
    const release = deferred<void>()
    fake.client.stopAudioCapture = async () => {
      fake.events.push("stop")
      await release.promise
      if (failure === "request") throw new Error("Stop denied")
      return { type: "rejected", reason: "not-joined" }
    }
    const model = createAudioVisualization({
      connect: async () => fake.client,
      confirm: async () => true,
    })
    const actions: Promise<void>[] = []
    try {
      await select(model)
      await model.start()
      const first = model.stop()
      const second = model.stop()
      actions.push(first, second)
      const results = Promise.allSettled(actions)
      expect(first).toBe(second)
      release.resolve()
      const outcomes = await results
      expect(outcomes.map((outcome) => outcome.status)).toEqual(
        failure === "request"
          ? ["rejected", "rejected"]
          : ["fulfilled", "fulfilled"],
      )
      expect(fake.events.filter((event) => event === "stop")).toHaveLength(1)
      expect(fake.events.at(-1)).toBe("dispose")
      const message = model.current().message
      expect(message).toContain(
        failure === "request" ? "Stop unconfirmed" : "Stop not confirmed",
      )
      await model.stop()
      expect(model.current().message).toBe(message)
    } finally {
      release.resolve()
      await Promise.allSettled(actions)
      await model.dispose()
    }
  })

  test(`failed ${failure} cleanup of late Start admission drops uncertain interest`, async () => {
    const fake = connection()
    const entered = deferred<void>()
    const admission = deferred<AudioStartResult>()
    fake.client.startAudioCapture = () => {
      entered.resolve()
      return admission.promise
    }
    let stops = 0
    fake.client.stopAudioCapture = async () => {
      fake.events.push("stop")
      if (++stops === 1)
        return { type: "stopped", generation: 1, reason: "stop" }
      if (failure === "request") throw new Error("Late Stop denied")
      return { type: "rejected", reason: "not-joined" }
    }
    const model = createAudioVisualization({
      connect: async () => fake.client,
      confirm: async () => true,
    })
    let action: Promise<void> | undefined
    try {
      await select(model)
      action = model.start()
      const outcome = action.then(
        () => "completed",
        () => "failed",
      )
      await entered.promise
      await model.stop()
      admission.resolve({
        type: "started",
        generation: 1,
        source: frame.source,
      })
      expect(await outcome).toBe(failure === "request" ? "failed" : "completed")
      expect(stops).toBe(2)
      expect(fake.events.at(-1)).toBe("dispose")
      expect(fake.features.size).toBe(0)
      expect(model.current().selected).toBeNull()
      expect(model.current().message).toContain(
        failure === "request" ? "Stop unconfirmed" : "Stop not confirmed",
      )
    } finally {
      admission.resolve({ type: "busy" })
      await model.dispose()
      await Promise.allSettled(action ? [action] : [])
    }
  })
}

test("late cleanup cannot replace the shared outcome of a Stop still in flight", async () => {
  const fake = connection()
  const entered = deferred<void>()
  const stopEntered = deferred<void>()
  const releaseStop = deferred<void>()
  const lateQueued = deferred<void>()
  const admission = deferred<AudioStartResult>()
  fake.client.startAudioCapture = () => {
    entered.resolve()
    return admission.promise
  }
  let stops = 0
  fake.client.stopAudioCapture = async () => {
    if (++stops === 1) {
      stopEntered.resolve()
      await releaseStop.promise
      throw new Error("Stop denied")
    }
    return { type: "rejected", reason: "not-joined" }
  }
  const model = createAudioVisualization({
    connect: async () => fake.client,
    confirm: async () => true,
  })
  const remove = model.subscribe((state) => {
    if (state.message === "Retiring late capture admission")
      lateQueued.resolve()
  })
  const actions: Promise<void>[] = []
  try {
    await select(model)
    const starting = model.start()
    actions.push(starting)
    await entered.promise
    const first = model.stop()
    actions.push(first)
    await stopEntered.promise
    admission.resolve({ type: "started", generation: 1, source: frame.source })
    await lateQueued.promise
    const second = model.stop()
    actions.push(second)
    const results = Promise.allSettled([first, second])
    expect(second).toBe(first)
    releaseStop.resolve()
    expect((await results).map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ])
    await starting
    expect(model.current().message).toContain("Stop not confirmed")
  } finally {
    remove()
    releaseStop.resolve()
    admission.resolve({ type: "busy" })
    await model.dispose()
    await Promise.allSettled(actions)
  }
})

test("a subscriber's reentrant Stop shares the promise established before publication", async () => {
  const fake = connection()
  const model = createAudioVisualization({
    connect: async () => fake.client,
    confirm: async () => true,
  })
  let nested: Promise<void> | undefined
  let reentered = false
  const remove = model.subscribe((state) => {
    if (state.message === "Stopping shared capture" && !reentered) {
      reentered = true
      nested = model.stop()
    }
  })
  let outer: Promise<void> | undefined
  try {
    await select(model)
    await model.start()
    outer = model.stop()
    expect(nested).toBe(outer)
    await outer
    expect(fake.events.filter((event) => event === "stop")).toHaveLength(1)
  } finally {
    remove()
    const joined = Promise.allSettled(
      [outer, nested].filter((action) => action !== undefined),
    )
    await model.dispose()
    await joined
  }
})

test("selection started during normal Stop also joins late cleanup queued behind that Stop", async () => {
  const fake = connection()
  const startEntered = deferred<void>()
  const stopEntered = deferred<void>()
  const releaseStop = deferred<void>()
  const lateQueued = deferred<void>()
  const cleanupEntered = deferred<void>()
  const releaseCleanup = deferred<void>()
  const admission = deferred<AudioStartResult>()
  fake.client.startAudioCapture = () => {
    startEntered.resolve()
    return admission.promise
  }
  let stops = 0
  let cleanupReleased = false
  fake.client.stopAudioCapture = async () => {
    if (++stops === 1) {
      stopEntered.resolve()
      await releaseStop.promise
    } else {
      cleanupEntered.resolve()
      await releaseCleanup.promise
    }
    return { type: "stopped", generation: 1, reason: "stop" }
  }
  const model = createAudioVisualization({
    connect: async () => fake.client,
    confirm: async () => true,
  })
  const remove = model.subscribe((state) => {
    if (state.message === "Retiring late capture admission")
      lateQueued.resolve()
  })
  const actions: Promise<void>[] = []
  try {
    await select(model)
    const starting = model.start()
    actions.push(starting)
    await startEntered.promise
    const stopping = model.stop()
    actions.push(stopping)
    await stopEntered.promise
    admission.resolve({ type: "started", generation: 1, source: frame.source })
    await lateQueued.promise
    fake.client.listAudioSources = async () => {
      expect(cleanupReleased).toBe(true)
      fake.events.push("list")
      return { availability: "available", sources: [selected] }
    }
    const choosing = select(model)
    actions.push(choosing)
    const selectedOutcome = choosing.then(
      () => "selected",
      () => "failed",
    )
    releaseStop.resolve()
    await stopping
    await cleanupEntered.promise
    expect(fake.events.filter((event) => event === "list")).toHaveLength(1)
    cleanupReleased = true
    releaseCleanup.resolve()
    expect(await selectedOutcome).toBe("selected")
    expect(model.current().selected).toEqual(selected)
    await starting
  } finally {
    remove()
    cleanupReleased = true
    releaseStop.resolve()
    releaseCleanup.resolve()
    admission.resolve({ type: "busy" })
    const joined = Promise.allSettled(actions)
    await model.dispose()
    await joined
  }
})

test("terminal notification before pending Stop rejection preserves the unconfirmed shared outcome", async () => {
  const fake = connection()
  const entered = deferred<void>()
  const release = deferred<void>()
  fake.client.stopAudioCapture = async () => {
    entered.resolve()
    await release.promise
    throw new Error("connection ended")
  }
  const model = createAudioVisualization({
    connect: async () => fake.client,
    confirm: async () => true,
  })
  let action: Promise<void> | undefined
  try {
    await select(model)
    await model.start()
    action = model.stop()
    const result = action.then(
      () => "completed",
      () => "failed",
    )
    await entered.promise
    for (const listener of fake.terminal)
      listener(
        new MusicSessionClientError({
          code: "CONNECTION_LOST",
          message: "connection ended",
          retryable: true,
        }),
      )
    release.resolve()
    expect(await result).toBe("failed")
    expect(model.current().message).toContain("Stop unconfirmed")
    const message = model.current().message
    await model.stop()
    expect(model.current().message).toBe(message)
    expect(fake.events.filter((event) => event === "dispose")).toHaveLength(1)
  } finally {
    release.resolve()
    await model.dispose()
    await Promise.allSettled(action ? [action] : [])
  }
})

test("lease expiry retires the old connection; fresh selection and confirmation can rejoin on a new socket", async () => {
  const first = connection()
  const second = connection()
  second.client.subscribeAudioStatus = (listener) => {
    // A new socket can replay the daemon's previous stopped generation.
    listener({ type: "stopped", generation: 1, reason: "lease-expired" })
    return () => {}
  }
  let connections = 0
  let confirmations = 0
  const model = createAudioVisualization({
    connect: async () => (++connections === 1 ? first.client : second.client),
    confirm: async () => {
      confirmations++
      return true
    },
  })
  try {
    await select(model)
    await model.start()
    for (const listener of first.status)
      listener({ type: "stopped", generation: 1, reason: "lease-expired" })
    expect(first.events.at(-1)).toBe("dispose")
    expect(model.current().selected).toBeNull()
    expect(second.events).toEqual([])
    await select(model)
    expect(connections).toBe(2)
    expect(second.events).toEqual(["list"])
    await model.start()
    expect(confirmations).toBe(2)
    expect(second.events).toEqual(["list", "start"])
  } finally {
    await model.dispose()
  }
})

test("known joined expiry closes the view's old connection even after source loss already cleared its current interest", async () => {
  const first = connection()
  const second = connection()
  let connects = 0
  const model = createAudioVisualization({
    connect: async () => (++connects === 1 ? first.client : second.client),
    confirm: async () => true,
  })
  try {
    await select(model)
    await model.start()
    for (const listener of first.status)
      listener({ type: "stopped", generation: 1, reason: "source-loss" })
    expect(model.current().active).toBe(false)
    expect(first.events).not.toContain("dispose")
    for (const listener of first.status)
      listener({ type: "stopped", generation: 1, reason: "lease-expired" })
    expect(first.events.at(-1)).toBe("dispose")
    await select(model)
    expect(connects).toBe(2)
    expect(second.events).toEqual(["list"])
  } finally {
    await model.dispose()
  }
})

for (const waitingOn of ["source list", "source dialog"] as const) {
  test(`late retirement fences selection already waiting on the ${waitingOn}`, async () => {
    const fake = connection()
    const startEntered = deferred<void>()
    const admission = deferred<AudioStartResult>()
    const cleanupEntered = deferred<void>()
    const releaseCleanup = deferred<void>()
    const selectionEntered = deferred<void>()
    const list = deferred<AudioSourceList>()
    const chosen = deferred<AudioSourceList["sources"][number]>()
    fake.client.startAudioCapture = () => {
      startEntered.resolve()
      return admission.promise
    }
    let stops = 0
    fake.client.stopAudioCapture = async () => {
      if (++stops > 1) {
        cleanupEntered.resolve()
        await releaseCleanup.promise
      }
      return { type: "stopped", generation: 1, reason: "stop" }
    }
    const model = createAudioVisualization({
      connect: async () => fake.client,
      confirm: async () => true,
    })
    const actions: Promise<void>[] = []
    try {
      await select(model)
      const starting = model.start()
      actions.push(starting)
      await startEntered.promise
      await model.stop()
      fake.client.listAudioSources = () => {
        if (waitingOn === "source list") {
          selectionEntered.resolve()
          return list.promise
        }
        return Promise.resolve({
          availability: "available",
          sources: [selected],
        })
      }
      let dialogs = 0
      const choosing = model.chooseSource(() => {
        dialogs++
        selectionEntered.resolve()
        return chosen.promise
      })
      actions.push(choosing)
      await selectionEntered.promise
      admission.resolve({
        type: "started",
        generation: 1,
        source: frame.source,
      })
      await cleanupEntered.promise
      list.resolve({ availability: "available", sources: [selected] })
      chosen.resolve(selected)
      await choosing
      expect(model.current().selected).toBeNull()
      expect(dialogs).toBe(waitingOn === "source list" ? 0 : 1)
      expect(model.current().message).toBe("Retiring late capture admission")
      releaseCleanup.resolve()
      await starting
    } finally {
      list.resolve({ availability: "available", sources: [selected] })
      chosen.resolve(selected)
      admission.resolve({ type: "busy" })
      releaseCleanup.resolve()
      await model.dispose()
      await Promise.allSettled(actions)
    }
  })
}

test("host-owned dialog may remain pending, but disposal joins our wait and ignores its late approval", async () => {
  const fake = connection()
  const dialogs = createAudioDialogWaits()
  const entered = deferred<void>()
  const approval = deferred<boolean>()
  const model = createAudioVisualization({
    connect: async () => fake.client,
    confirm: async () =>
      (await dialogs.run(() => {
        entered.resolve()
        return approval.promise
      })) === true,
    cancelPendingDialogs: async () => dialogs.cancel(),
  })
  let action: Promise<void> | undefined
  try {
    await select(model)
    action = model.start()
    await entered.promise
    await model.dispose()
    await action
    expect(fake.events).toEqual(["list", "dispose"])
    approval.resolve(true)
    await approval.promise
    expect(fake.events).not.toContain("start")
  } finally {
    dialogs.cancel()
    approval.resolve(false)
    await model.dispose()
    await action
  }
})

test("Stop cancels our pending confirmation so fresh selection can start without waiting for a late host answer", async () => {
  const fake = connection()
  const dialogs = createAudioDialogWaits()
  const entered = deferred<void>()
  const approval = deferred<boolean>()
  let confirmations = 0
  const model = createAudioVisualization({
    connect: async () => fake.client,
    confirm: async () =>
      (await dialogs.run(() => {
        if (++confirmations > 1) return Promise.resolve(true)
        entered.resolve()
        return approval.promise
      })) === true,
    cancelPendingDialogs: async () => dialogs.cancel(),
  })
  let action: Promise<void> | undefined
  try {
    await select(model)
    action = model.start()
    await entered.promise
    await model.stop()
    await action
    expect(fake.events).not.toContain("start")
    await select(model)
    await model.start()
    expect(confirmations).toBe(2)
    approval.resolve(true)
    await approval.promise
    expect(fake.events.filter((event) => event === "start")).toHaveLength(1)
  } finally {
    dialogs.cancel()
    approval.resolve(false)
    await model.dispose()
    await action
  }
})

for (const pendingAction of ["confirmation", "selection"] as const) {
  test(`disposal cancels and joins pending ${pendingAction} without granting capture`, async () => {
    const fake = connection()
    const entered = deferred<void>()
    const release = deferred<void>()
    let finished = false
    let canceled = false
    const model = createAudioVisualization({
      connect: async () => fake.client,
      confirm: async () => {
        entered.resolve()
        await release.promise
        finished = true
        return true
      },
      cancelPendingDialogs: async () => {
        canceled = true
        release.resolve()
      },
    })
    let action: Promise<void> | undefined
    try {
      if (pendingAction === "confirmation") {
        await select(model)
        action = model.start()
      } else {
        action = model.chooseSource(async (list) => {
          entered.resolve()
          await release.promise
          finished = true
          return list.sources[0]
        })
      }
      await entered.promise
      await model.dispose()
      expect(canceled).toBe(true)
      expect(finished).toBe(true)
      expect(fake.events).toEqual(["list", "dispose"])
      expect(fake.features.size).toBe(0)
    } finally {
      release.resolve()
      await model.dispose()
      await action
    }
  })
}

test("without a host cancellation hook disposal still joins a pending confirmation", async () => {
  const fake = connection()
  const entered = deferred<void>()
  const consent = deferred<boolean>()
  const model = createAudioVisualization({
    connect: async () => fake.client,
    confirm: () => {
      entered.resolve()
      return consent.promise
    },
  })
  let action: Promise<void> | undefined
  try {
    await select(model)
    action = model.start()
    await entered.promise
    let closed = false
    const disposal = model.dispose().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    consent.resolve(true)
    await disposal
    expect(fake.events).not.toContain("start")
  } finally {
    consent.resolve(false)
    await model.dispose()
    await action
  }
})

test("disposing a pending connection closes its late result and never replays Start", async () => {
  const fake = connection()
  const connected = deferred<AudioConnection>()
  const entering = deferred<void>()
  const model = createAudioVisualization({
    connect: () => {
      entering.resolve()
      return connected.promise
    },
    confirm: async () => true,
  })
  const choosing = select(model)
  await entering.promise
  const disposed = model.dispose()
  connected.resolve(fake.client)
  await choosing.catch(() => undefined)
  await disposed
  expect(fake.events).toEqual(["dispose"])
})

test("a shared Stop cannot be overwritten by a late successful Start response", async () => {
  const fake = connection()
  const admitted = deferred<AudioStartResult>()
  const entered = deferred<void>()
  fake.client.startAudioCapture = () => {
    entered.resolve()
    return admitted.promise
  }
  const model = createAudioVisualization({
    connect: async () => fake.client,
    confirm: async () => true,
  })
  try {
    await select(model)
    const start = model.start()
    await entered.promise
    for (const listener of fake.status)
      listener({ type: "stopped", generation: 1, reason: "stop" })
    admitted.resolve({ type: "started", generation: 1, source: frame.source })
    await start
    expect(model.current().active).toBe(false)
    expect(model.current().selected).toBeNull()
    expect(model.current().message).toContain("Capture off")
  } finally {
    admitted.resolve({ type: "busy" })
    await model.dispose()
  }
})

test("an already-terminal connection cannot retain partially registered view listeners", async () => {
  const fake = connection()
  fake.client.subscribeTerminal = (listener) => {
    listener(
      new MusicSessionClientError({
        code: "CONNECTION_LOST",
        message: "already closed",
        retryable: true,
      }),
    )
    return () => {}
  }
  const model = createAudioVisualization({
    connect: async () => fake.client,
    confirm: async () => true,
  })
  try {
    await select(model)
    expect(fake.features.size).toBe(0)
    expect(fake.status.size).toBe(0)
    expect(fake.events).toEqual(["dispose"])
    expect(model.current().selected).toBeNull()
  } finally {
    await model.dispose()
  }
})

test("disconnection clears consent and ignores late frames; reconnect requires selection and explicit Start", async () => {
  const first = connection()
  const second = connection()
  let connections = 0
  const model = createAudioVisualization({
    connect: async () => (++connections === 1 ? first.client : second.client),
    confirm: async () => true,
  })
  try {
    await select(model)
    await model.start()
    const late = [...first.features]
    for (const listener of first.terminal)
      listener(
        new MusicSessionClientError({
          code: "CONNECTION_LOST",
          message: "fixture lost",
          retryable: true,
        }),
      )
    for (const listener of late) listener(frame)
    expect(model.current().selected).toBeNull()
    expect(model.current().frame).toBeNull()
    expect(model.current().active).toBe(false)
    expect(connections).toBe(1)
    await expect(model.start()).rejects.toThrow("fresh source")
    await select(model)
    expect(second.events).toEqual(["list"])
    await model.start()
    expect(second.events).toEqual(["list", "start"])
  } finally {
    await model.dispose()
  }
})

test("a failed Start drops this connection's interest instead of leaving unknown capture active", async () => {
  const fake = connection()
  fake.client.startAudioCapture = async () => {
    throw new Error("connection lost")
  }
  const model = createAudioVisualization({
    connect: async () => fake.client,
    confirm: async () => true,
  })
  await select(model)
  await expect(model.start()).rejects.toThrow("connection lost")
  expect(fake.events.at(-1)).toBe("dispose")
  expect(model.current().active).toBe(false)
  expect(model.current().selected).toBeNull()
  await model.dispose()
})

test("all styles fit narrow layouts, stereo retains both channels, and silence is not generated energy", () => {
  for (const width of [1, 3, 8, 15, 24])
    for (const rows of [1, 4, 6])
      for (const style of audioStyles) {
        const lines = renderAudioFeatures(frame, style, width, rows)
        expect(lines.length).toBeLessThanOrEqual(rows)
        expect(lines.every((line) => [...line].length <= width)).toBe(true)
      }
  const compact = renderAudioFeatures(frame, "meters", 24, 1).join("")
  expect(compact).toContain("L")
  expect(compact).toContain("R")
  expect(compact).toContain("│")
  expect(renderAudioFeatures(frame, "meters", 24, 6).join("\n")).toContain(
    "dBFS",
  )
  const silence = {
    ...frame,
    spectrum: [0, 0],
    envelope: [{ min: 0, max: 0 }],
    channels: { layout: "stereo" as const, rms: [0, 0], peaks: [0, 0] },
  }
  expect(renderAudioFeatures(silence, "spectrum", 24, 1).join("").trim()).toBe(
    "",
  )
  expect(renderAudioFeatures(silence, "scope", 24, 1).join("").trim()).toBe("")
  expect(renderAudioFeatures(silence, "meters", 24, 1).join("")).not.toMatch(
    /[█│]/,
  )
})
