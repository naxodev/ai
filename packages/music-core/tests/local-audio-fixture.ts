/** Real subprocess/socket fixture. It synthesizes features and never opens audio devices. */
import { strict as assert } from "node:assert"
import { Effect } from "effect"
import {
  liveNativeHelperDependencies,
  type NativeHelperDependencies,
  type NativeHelperExit,
} from "../audio/helper-process.ts"
import { localKasetLayer } from "../audio/local-kaset.ts"
import {
  createFakeProvider,
  startMusicSessionServer,
} from "../session/server.ts"

export async function startLocalAudioFixture(
  socketPath: string,
  captureSpawn?: NativeHelperDependencies["spawn"],
) {
  let launch = "100:0"
  let starts = 0
  const exits: Promise<NativeHelperExit>[] = []
  const catalog = () => ({
    sources: [
      {
        identity: {
          kind: "native",
          processIdentifier: 42,
          launchIdentity: launch,
          executableIdentity: "/fixture/kaset-gpu|abcdef12",
          coreAudioObject: "99",
        },
        runningOutput: true,
      },
    ],
  })
  const dependencies: NativeHelperDependencies = {
    ...liveNativeHelperDependencies,
    // Offline fixtures cannot depend on a generated artifact or the host OS.
    artifactPresent: () => true,
    verify: () => Effect.succeed(true),
    spawn: (request) => {
      if (request.args[0] === "--list-kaset-sources")
        return liveNativeHelperDependencies.spawn({
          executable: process.execPath,
          args: [
            "-e",
            `console.log(${JSON.stringify(JSON.stringify(catalog()))})`,
          ],
          shell: false,
        })
      assert.equal(request.args[0], "--protocol")
      assert.deepEqual(request.args.slice(-2), [
        "--attribution",
        "kaset-cache-v1",
      ])
      starts++
      if (captureSpawn) {
        const child = captureSpawn(request)
        exits.push(Effect.runPromise(child.exit))
        return child
      }
      const child = liveNativeHelperDependencies.spawn({
        executable: process.execPath,
        shell: false,
        args: [
          "-e",
          `
let buffer = "", anchor
process.stdin.on("data", chunk => {
  buffer += chunk.toString()
  let split
  while ((split = buffer.indexOf("\\n")) >= 0) {
    const value = JSON.parse(buffer.slice(0, split))
    buffer = buffer.slice(split + 1)
    anchor = { parent: value.timestampMs, local: performance.now() }
    emit()
  }
})
function emit() {
  if (!anchor) return
  console.log(JSON.stringify({ timestampMs: anchor.parent + performance.now() - anchor.local - 40, sampleAgeMs: 40,
    clockDomain: "capture-monotonic", spectrum: [.8,.3], envelope: [{ min: -.5, max: .5 }],
    channels: { layout: "stereo", rms: [.2,.1], peaks: [.4,.2] } }))
}
const timer = setInterval(emit, 50)
const stop = () => { clearInterval(timer); process.exit(0) }
process.stdin.on("end", stop)
process.on("SIGTERM", stop)
`,
        ],
      })
      exits.push(Effect.runPromise(child.exit))
      return child
    },
  }
  const server = await startMusicSessionServer(
    { socketPath },
    createFakeProvider(),
    {},
    (id, observations) => localKasetLayer(id, observations, dependencies),
  )
  const waitCapturesClosed = async () => {
    for (const exit of await Promise.all(exits))
      assert.deepEqual(exit, { code: 0, signal: null })
  }
  return {
    starts: () => starts,
    setLaunch(value: string) {
      launch = value
    },
    waitCapturesClosed,
    async close() {
      await server.close()
      await waitCapturesClosed()
    },
  }
}
