/** Only the separately approved app harness runs this live entrypoint. */
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { createMusicSessionClient } from "../../session/client.ts"
import { baselineCapabilities } from "../../session/protocol.ts"
import { audioVisualizationCapabilities } from "../../audio/schema.ts"
import {
  createFakeProvider,
  startMusicSessionServer,
} from "../../session/server.ts"
import { createAudioVisualization } from "../../../opencode-music-player/audio-visualization.ts"
import { sckPrototypeLayer } from "./adapter.ts"
import { withProbeDiagnostics, type ProbeDiagnostic } from "./diagnostics.ts"
import { liveNativeHelperDependencies } from "../../audio/helper-process.ts"

export async function runProbe(stage: string) {
  if (!["deny", "allow", "revoke"].includes(stage))
    throw new Error("Choose deny, allow, or revoke")
  const directory = join(import.meta.dir, "dist/live-evidence")
  await mkdir(directory, { recursive: true })
  const socketPath = "/tmp/sck-probe-" + process.pid + ".sock"
  const startedAt = new Date().toISOString()
  const nativeDiagnostics: Array<ProbeDiagnostic & { at: string }> = []
  const server = await startMusicSessionServer(
    { socketPath },
    createFakeProvider(),
    {},
    (id, observations) =>
      Layer.unwrap(
        withProbeDiagnostics(liveNativeHelperDependencies, (diagnostic) => {
          if (nativeDiagnostics.length < 64)
            nativeDiagnostics.push({
              ...diagnostic,
              at: new Date().toISOString(),
            })
        }).pipe(
          Effect.map((boundary) =>
            sckPrototypeLayer(id, observations, boundary),
          ),
        ),
      ),
  )
  const model = createAudioVisualization({
    connect: () =>
      createMusicSessionClient({
        socketPath,
        clientId: "sck-probe",
        hostKind: "test",
        capabilities: [
          ...baselineCapabilities,
          ...audioVisualizationCapabilities,
        ],
      }),
    // Used only under separate approval. Native identity checks still refuse
    // ambiguity and PID reuse; the app stage button authorizes this bounded probe.
    confirm: async () => true,
  })
  let frames = 0
  let nonzeroFrames = 0
  let peakRms = 0
  let sequence = -1
  let activeEver = false
  const messages: string[] = []
  const unsubscribe = model.subscribe((state) => {
    activeEver = activeEver || state.active
    if (messages.at(-1) !== state.message && messages.length < 64)
      messages.push(state.message)
    if (!state.active || !state.frame || state.frame.sequence === sequence)
      return
    sequence = state.frame.sequence
    frames++
    if (state.frame.spectrum.some((value) => value > 0)) nonzeroFrames++
    for (const value of state.frame.channels?.rms ?? [])
      peakRms = Math.max(peakRms, value)
  })
  let failed: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 15_000)
  })
  const work = (async () => {
    try {
      await model.chooseSource(async (list) =>
        list.sources.length === 1 ? list.sources[0] : undefined,
      )
      if (!model.current().selected) {
        failed = "source-unavailable"
        return
      }
      await model.start()
      if (model.current().active) await deadline
    } catch {
      failed = "probe-failed"
    }
  })()
  try {
    await Promise.race([work, deadline])
  } finally {
    if (timer) clearTimeout(timer)
    unsubscribe()
    await model.dispose()
    await work
    await server.close()
  }
  // Retain summaries only. No PCM, feature arrays, window titles, or app catalog.
  const result = {
    stage,
    startedAt,
    finishedAt: new Date().toISOString(),
    frames,
    nonzeroFrames,
    peakRms,
    activeEver,
    messages,
    nativeDiagnostics,
    failed,
  }
  await Bun.write(
    join(directory, stage + "-result.json"),
    JSON.stringify(result, null, 2),
  )
  console.log(JSON.stringify(result))
}

if (import.meta.main) {
  const stage = process.argv[2]
  if (!stage) throw new Error("Choose deny, allow, or revoke")
  await runProbe(stage)
}
