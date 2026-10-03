import { expect, test } from "bun:test"
import {
  audioVisualizationCapability,
  baselineCapabilities,
  createMusicSessionClient,
} from "@naxodev/music-core"
import { startLocalAudioFixture } from "../../music-core/tests/local-audio-fixture.ts"
import {
  createAudioVisualization,
  type AudioViewState,
} from "../audio-visualization.ts"

const waitFor = (
  model: ReturnType<typeof createAudioVisualization>,
  predicate: (state: AudioViewState) => boolean,
) => {
  if (predicate(model.current())) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error("audio model did not reach expected state"))
    }, 3000)
    const unsubscribe = model.subscribe((state) => {
      if (!predicate(state)) return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    })
  })
}

test("two real daemon clients explicitly join one synthetic helper; hidden and metadata-only windows cannot retain capture", async () => {
  const socketPath = `/tmp/music-local-daemon-${process.pid}-${crypto.randomUUID()}.sock`
  const fixture = await startLocalAudioFixture(socketPath)
  const client = (id: string) =>
    createMusicSessionClient({
      socketPath,
      clientId: id,
      hostKind: "test",
      capabilities: [...baselineCapabilities, audioVisualizationCapability],
    })
  const a = createAudioVisualization({
    connect: () => client("window-a"),
    confirm: async () => true,
  })
  const b = createAudioVisualization({
    connect: () => client("window-b"),
    confirm: async () => true,
  })
  const metadata = await createMusicSessionClient({
    socketPath,
    clientId: "metadata-only",
    hostKind: "test",
  })
  try {
    expect(fixture.starts()).toBe(0)
    await a.chooseSource(async (list) => list.sources[0])
    expect(fixture.starts()).toBe(0)
    await a.start()
    await waitFor(a, (state) => state.active && state.frame !== null)
    await b.chooseSource(async (list) => list.sources[0])
    expect(b.current().active).toBe(false)
    await b.start()
    await waitFor(b, (state) => state.active && state.frame !== null)
    expect(b.current().message).toBe("Joined shared capture")
    expect(fixture.starts()).toBe(1)
    for (const style of ["mirror", "scope", "meters", "spectrum"] as const)
      a.setStyle(style)
    expect(fixture.starts()).toBe(1)
    await a.dispose()
    const sequence = b.current().frame?.sequence ?? 0
    await waitFor(b, (state) => (state.frame?.sequence ?? 0) > sequence)
    expect(b.current().active).toBe(true)
    await b.stop()
    await waitFor(b, (state) => state.frame === null)
    await fixture.waitCapturesClosed()
    expect(await metadata.play()).toEqual({ action: "play" })

    await b.chooseSource(async (list) => list.sources[0])
    fixture.setLaunch("101:0")
    await b.start()
    expect(b.current().message).toContain("pid-reuse")
    expect(fixture.starts()).toBe(1)
    await b.chooseSource(async (list) => list.sources[0])
    await b.start()
    await waitFor(b, (state) => state.active && state.frame !== null)
    expect(fixture.starts()).toBe(2)
    await b.dispose()
    await fixture.waitCapturesClosed()
    // The metadata client is still alive. It does not retain the last joined helper.
    expect(await metadata.play()).toEqual({ action: "play" })
  } finally {
    await a.dispose()
    await b.dispose()
    metadata.dispose()
    await fixture.close()
  }
})
