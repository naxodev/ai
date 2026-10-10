/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import { Show, createSignal } from "solid-js"
import type { AudioFeatureFrame, AudioSourceList } from "@naxodev/music-core"
import { AudioSidebar } from "../audio-sidebar.tsx"
import {
  createAudioVisualization,
  type AudioConnection,
} from "../audio-visualization.ts"

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
    executableIdentity: "fixture",
    coreAudioObject: "99",
  },
  capabilities: {
    spectrum: "measured",
    envelope: "measured",
    channels: "stereo",
  },
  spectrum: [0.8, 0.3],
  envelope: [{ min: -0.5, max: 0.5 }],
  channels: { layout: "stereo", rms: [0.2, 0.1], peaks: [0.4, 0.2] },
}

test("the mounted sidebar renders measured styles, clears stale data, and releases ownership when hidden", async () => {
  let starts = 0
  let disposals = 0
  const errors: unknown[] = []
  const features = new Set<
    Parameters<AudioConnection["subscribeAudioFeatures"]>[0]
  >()
  const client: AudioConnection = {
    listAudioSources: async () => ({
      availability: "available",
      sources: [
        {
          token: "token",
          label: "Kaset (WebKit) · PID 42",
          mode: "process",
          capabilities: frame.capabilities,
        },
      ],
    }),
    startAudioCapture: async () => {
      starts++
      return { type: "started", generation: 1, source: frame.source }
    },
    stopAudioCapture: async () => ({
      type: "stopped",
      generation: 1,
      reason: "stop",
    }),
    subscribeAudioStatus: (listener) => {
      listener({ type: "idle" })
      return () => {}
    },
    subscribeAudioFeatures: (listener) => {
      features.add(listener)
      return () => {
        features.delete(listener)
      }
    },
    subscribeTerminal: () => () => {},
    dispose: () => {
      disposals++
    },
  }
  const model = createAudioVisualization({
    connect: async () => client,
    confirm: async () => true,
  })
  const [visible, setVisible] = createSignal(true)
  const [height, setHeight] = createSignal(65)
  const app = await testRender(
    () => (
      <Show when={visible()}>
        <AudioSidebar
          model={model}
          width={30}
          height={height()}
          foreground={RGBA.fromHex("#ffffff")}
          muted={RGBA.fromHex("#888888")}
          onError={(error) => {
            errors.push(error)
          }}
        />
      </Show>
    ),
    { width: 30, height: 20 },
  )
  try {
    await app.waitForFrame(
      (text) =>
        text.includes("Capture off") && text.includes("No fresh signal"),
    )
    expect(starts).toBe(0)
    await model.chooseSource(async (list) => list.sources[0])
    await model.start()
    for (const listener of features) listener(frame)
    await app.waitForFrame(
      (text) => text.includes("spectrum") && text.includes("█"),
    )
    model.setStyle("mirror")
    await app.waitForFrame(
      (text) => text.includes("mirror") && text.includes("█"),
    )
    model.setStyle("scope")
    await app.waitForFrame(
      (text) => text.includes("scope") && text.includes("│"),
    )
    setHeight(35)
    await app.waitForFrame(
      (text) => text.includes("scope (envelope)") && /[▁▂▃▄▅▆▇█]/.test(text),
    )
    model.setStyle("meters")
    const compact = await app.waitForFrame((text) =>
      /L[█░│]+ R[█░│]+/.test(text),
    )
    expect(compact).toContain("R")
    setHeight(65)
    await app.waitForFrame((text) => text.includes("dBFS"))
    expect(starts).toBe(1)
    for (const listener of features)
      listener({ type: "clear", reason: "stale", generation: 1, sequence: 2 })
    await app.waitForFrame(
      (text) => text.includes("No fresh signal") && !text.includes("dBFS"),
    )
    setVisible(false)
    await app.waitForFrame((text) => text.trim() === "")
    await model.dispose()
    expect(features.size).toBe(0)
    expect(disposals).toBe(1)
    expect(errors).toEqual([])
  } finally {
    app.renderer.destroy()
    await model.dispose()
  }
})

for (const { reason, message, narrow } of [
  {
    reason: "capture-adapter-unavailable",
    message: "Helper off: check build",
    narrow: "Helper off:",
  },
  {
    reason: "not-negotiated",
    message: "Update audio daemon",
    narrow: "Update audio",
  },
  {
    reason: "unsupported",
    message: "Audio unsupported",
    narrow: "Audio unsupp",
  },
  {
    reason: "private title\u001b[31m" as unknown as NonNullable<
      AudioSourceList["reason"]
    >,
    message: "Audio unavailable",
    narrow: "Audio unavai",
  },
] satisfies readonly {
  reason: NonNullable<AudioSourceList["reason"]>
  message: string
  narrow: string
}[]) {
  test(`${message} remains useful in the actual 24-column sidebar and identifies the cause when narrowed`, async () => {
    let starts = 0
    const errors: unknown[] = []
    const client: AudioConnection = {
      listAudioSources: async () => ({
        availability: "unavailable",
        reason,
        sources: [],
      }),
      startAudioCapture: async () => {
        starts++
        return { type: "busy" }
      },
      stopAudioCapture: async () => ({
        type: "rejected",
        reason: "not-joined",
      }),
      subscribeAudioStatus: () => () => {},
      subscribeAudioFeatures: () => () => {},
      subscribeTerminal: () => () => {},
      dispose: () => {},
    }
    const model = createAudioVisualization({
      connect: async () => client,
      confirm: async () => true,
    })
    const [width, setWidth] = createSignal(30)
    const app = await testRender(
      () => (
        <AudioSidebar
          model={model}
          width={width()}
          height={65}
          foreground={RGBA.fromHex("#ffffff")}
          muted={RGBA.fromHex("#888888")}
          onError={(error) => {
            errors.push(error)
          }}
        />
      ),
      { width: 30, height: 20 },
    )
    try {
      await app.waitForFrame((text) => text.includes("Capture off"))
      await model.chooseSource(async (list) => list.sources[0])
      const normal = await app.waitForFrame(
        (text) =>
          !text.includes("Capture off") && text.includes("No fresh signal"),
      )
      expect(normal).toContain(message)
      expect(starts).toBe(0)
      setWidth(18)
      const compact = await app.waitForFrame(
        (text) => !text.includes(message) && text.includes("Not selected"),
      )
      expect(compact).toContain(narrow)
      expect(model.current().selected).toBeNull()
      expect(errors).toEqual([])
    } finally {
      app.renderer.destroy()
      await model.dispose()
    }
  })
}
