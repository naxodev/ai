import { expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { join } from "node:path"
import {
  Cause,
  Deferred,
  Effect,
  Layer,
  Queue,
  Result,
  Scope,
  Stream,
} from "effect"
import { testUnixSession } from "../../tests/unix-session.ts"
import { localMonotonicMs } from "../../audio/clock.ts"
import {
  helperError,
  liveNativeHelperDependencies,
  type NativeHelperDependencies,
  type NativeHelperExit,
  type NativeHelperProcess,
} from "../../audio/helper-process.ts"
import { createMusicSessionClient } from "../../session/client.ts"
import {
  createFakeProvider,
  startMusicSessionServer,
} from "../../session/server.ts"
import { baselineCapabilities } from "../../session/protocol.ts"
import {
  audioVisualizationCapabilities,
  type ResolvedCaptureSource,
} from "../../audio/schema.ts"
import {
  createAudioVisualization,
  type AudioViewState,
} from "../../../opencode-music-player/audio-visualization.ts"
import {
  permissionAwareProcess,
  makeSckAdapter,
  sckHelperIdentifier,
  sckHelperPath,
  sckPrototypeLayer,
} from "./adapter.ts"
import { withProbeDiagnostics, type ProbeDiagnostic } from "./diagnostics.ts"

const source: ResolvedCaptureSource = {
  mode: "process",
  label: "Synthetic Kaset",
  observationSequence: 0,
  attribution: "kaset-cache-v1",
  identity: {
    kind: "native",
    processIdentifier: 42,
    launchIdentity: "100:0",
    executableIdentity: "/fixture|abcdef12",
    coreAudioObject: "99",
  },
  capabilities: {
    spectrum: "measured",
    envelope: "measured",
    channels: "stereo",
  },
}

test("importing a probe with a valid stage never starts a daemon or capture", async () => {
  for (const stage of ["allow", "discover", "capture", "exclude"]) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        join(import.meta.dir, "import-safety-preload.ts"),
        join(import.meta.dir, "import-safety-fixture.ts"),
        stage,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000)
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect({ exit, stderr, stdout }).toEqual({
        exit: 0,
        stderr: "",
        stdout: "imported safely\n",
      })
    } finally {
      clearTimeout(timer)
    }
  }
})

function fixture(initialCode?: number, fault?: "stdout" | "heartbeat") {
  const input = Effect.runSync(Queue.bounded<Uint8Array, Cause.Done>(8))
  const exit = Deferred.makeUnsafe<NativeHelperExit>()
  const spawned = Deferred.makeUnsafe<void>()
  const events: string[] = []
  const finish = (code: number) => {
    Deferred.doneUnsafe(exit, Effect.succeed({ code, signal: null }))
    Queue.endUnsafe(input)
  }
  const process: NativeHelperProcess = {
    ready: Effect.void,
    stdout:
      fault === "stdout"
        ? Stream.fail(helperError())
        : fault === "heartbeat"
          ? Stream.never
          : Stream.fromQueue(input),
    stderr: Stream.never,
    exit: Deferred.await(exit),
    heartbeat: fault === "heartbeat" ? Effect.fail(helperError()) : Effect.void,
    stopIO: () => {
      events.push("stop-io")
      Queue.endUnsafe(input)
    },
    signal: (signal) => {
      events.push(signal)
      finish(0)
    },
  }
  const verified: { executable: string; identifier: string }[] = []
  let starts = 0
  const boundary: NativeHelperDependencies = {
    artifactPresent: () => true,
    verify: (executable, identifier) =>
      Effect.sync(() => {
        verified.push({ executable, identifier })
        return true
      }),
    spawn: (request) => {
      expect(request.executable).toBe(sckHelperPath)
      expect(request.shell).toBe(false)
      if (request.args[0] === "--list-kaset-sources")
        return {
          ...process,
          stdout: Stream.make(
            Buffer.from(
              `${JSON.stringify({ sources: [{ identity: source.identity, runningOutput: true }] })}\n`,
            ),
          ),
          stderr: Stream.empty,
          exit: Effect.succeed({ code: 0, signal: null }),
          stopIO: () => {},
          signal: () => {},
        }
      starts++
      Deferred.doneUnsafe(spawned, Effect.void)
      if (initialCode !== undefined) finish(initialCode)
      return process
    },
  }
  const frame = (value = 0) => {
    expect(
      Queue.offerUnsafe(
        input,
        Buffer.from(
          `${JSON.stringify({
            timestampMs: localMonotonicMs() - 40,
            sampleAgeMs: 40,
            clockDomain: "capture-monotonic",
            spectrum: [value],
            envelope: [{ min: -value, max: value }],
            channels: { layout: "stereo", rms: [value, 0], peaks: [value, 0] },
          })}\n`,
        ),
      ),
    ).toBe(true)
  }
  return {
    process,
    boundary,
    finish,
    frame,
    events,
    verified,
    spawned,
    starts: () => starts,
  }
}

test("only the prototype's reserved clean permission exit changes the existing adapter error", async () => {
  for (const code of [1, 70, 77, 124, 125]) {
    const child = fixture()
    child.finish(code)
    const wrapped = permissionAwareProcess(child.process)
    const outcome = await Effect.runPromise(
      wrapped.stdout.pipe(Stream.runDrain, Effect.exit),
    )
    const exited = await Effect.runPromise(wrapped.exit)
    expect(exited.code).toBe(code === 77 ? 0 : code)
    expect(outcome._tag).toBe(code === 77 ? "Failure" : "Success")
  }
})

test("confirmed initial denial cannot become readiness or a silent first frame", async () => {
  const child = fixture(77)
  const outcome = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = makeSckAdapter(child.boundary)
        return yield* adapter.start(source).pipe(Effect.exit)
      }),
    ),
  )
  expect(outcome._tag).toBe("Failure")
  if (outcome._tag !== "Failure") throw new Error("denial became ready")
  const error = Cause.findError(outcome.cause)
  expect(Result.isSuccess(error) && error.success.reason).toBe("permission")
  expect(child.events).toEqual(["stop-io", "SIGTERM"])
  expect(child.verified).toEqual([
    { executable: sckHelperPath, identifier: sckHelperIdentifier },
  ])
})

test("the real adapter retains a fixed native failure reason without treating it as consent", async () => {
  const child = fixture(1)
  const recorded: ProbeDiagnostic[] = []
  const boundary = withProbeDiagnostics(
    {
      ...child.boundary,
      spawn: (request) => ({
        ...child.boundary.spawn(request),
        stderr: Stream.make(
          Buffer.from(
            '{"event":"music-audio-helper-stop","reason":"source-loss"}\n',
          ),
        ),
      }),
    },
    (value) => recorded.push(value),
  )
  const outcome = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return yield* makeSckAdapter(yield* boundary)
          .start(source)
          .pipe(Effect.exit)
      }),
    ),
  )
  expect(outcome._tag).toBe("Failure")
  if (outcome._tag !== "Failure") throw new Error("source loss became ready")
  const error = Cause.findError(outcome.cause)
  expect(Result.isSuccess(error) && error.success.reason).toBe("setup")
  expect(recorded).toEqual([{ command: "capture", reason: "source-loss" }])
})

test("a generic operating-system permission error cannot claim system-audio denial", async () => {
  const child = fixture(1)
  const adapter = makeSckAdapter({
    ...child.boundary,
    spawn: (request) => ({
      ...child.boundary.spawn(request),
      ready: Effect.fail(helperError("permission")),
    }),
  })
  const outcome = await Effect.runPromise(
    Effect.scoped(adapter.start(source).pipe(Effect.exit)),
  )
  if (outcome._tag !== "Failure")
    throw new Error("failed OS operation became ready")
  const error = Cause.findError(outcome.cause)
  expect(Result.isSuccess(error) && error.success.reason).toBe("setup")
})

for (const fault of ["stdout", "heartbeat"] as const) {
  test(`confirmed denial remains permission when ${fault} fails during shutdown`, async () => {
    const child = fixture(77, fault)
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = makeSckAdapter(child.boundary)
          return yield* adapter.start(source).pipe(Effect.exit)
        }),
      ),
    )
    if (outcome._tag !== "Failure") throw new Error("denial became ready")
    const error = Cause.findError(outcome.cause)
    expect(Result.isSuccess(error) && error.success.reason).toBe("permission")
    expect(child.events).toEqual(["stop-io", "SIGTERM"])
  })
}

const waitFor = (
  model: ReturnType<typeof createAudioVisualization>,
  predicate: (state: AudioViewState) => boolean,
) => {
  if (predicate(model.current())) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`view did not reach state: ${model.current().message}`))
    }, 3000)
    const unsubscribe = model.subscribe((state) => {
      if (predicate(state)) {
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
    })
  })
}

for (const runningOutput of [true, false]) {
  testUnixSession(
    runningOutput
      ? "the diagnostic layer preserves verified source selection without starting capture"
      : "a verified Kaset process without running output cannot authorize a probe",
    async () => {
      const child = fixture()
      const recorded: ProbeDiagnostic[] = []
      let ownerClosed = false
      let captureRequests = 0
      let choices = 0
      const metadata =
        JSON.stringify({
          sources: [{ identity: source.identity, runningOutput }],
        }) + "\n"
      const metadataBoundary: NativeHelperDependencies = {
        ...child.boundary,
        spawn: (request) => {
          if (request.args[0] !== "--list-kaset-sources") {
            captureRequests++
            throw new Error("capture prohibited in metadata fixture")
          }
          return liveNativeHelperDependencies.spawn({
            executable: process.execPath,
            args: [
              "-e",
              "process.stdout.write(" + JSON.stringify(metadata) + ")",
            ],
            shell: false,
          })
        },
      }
      const socketPath = `/tmp/sck-metadata-${process.pid}-${crypto.randomUUID()}.sock`
      const server = await startMusicSessionServer(
        { socketPath },
        createFakeProvider(),
        {},
        (id, observations) =>
          Layer.unwrap(
            Effect.gen(function* () {
              const owner = yield* Scope.Scope
              yield* Scope.addFinalizer(
                owner,
                Effect.sync(() => {
                  ownerClosed = true
                }),
              )
              const boundary = yield* withProbeDiagnostics(
                metadataBoundary,
                (event) => recorded.push(event),
              )
              return sckPrototypeLayer(id, observations, boundary)
            }),
          ),
      )
      const model = createAudioVisualization({
        connect: () =>
          createMusicSessionClient({
            socketPath,
            clientId: "sck-metadata",
            hostKind: "test",
            capabilities: [
              ...baselineCapabilities,
              ...audioVisualizationCapabilities,
            ],
          }),
        confirm: async () => true,
      })
      try {
        expect(ownerClosed).toBe(false)
        await model.chooseSource(async (list) => {
          choices++
          return list.sources[0]
        })
        expect(model.current().selected !== null).toBe(runningOutput)
        expect(model.current().active).toBe(false)
        expect(captureRequests).toBe(0)
        expect(choices).toBe(runningOutput ? 1 : 0)
        if (!runningOutput)
          expect(model.current().message).toBe("Helper off: check build")
        expect(recorded).toEqual([])
      } finally {
        await model.dispose()
        await server.close()
      }
      expect(ownerClosed).toBe(true)
    },
  )
}

for (const scenario of [
  "denied",
  "revoked",
  "generic-stop",
  "explicit-stop",
] as const) {
  const initialDenial = scenario === "denied"
  testUnixSession(
    initialDenial
      ? "real daemon and sidebar model show initial permission denial without active status"
      : `real daemon keeps measured silence active then clears the sidebar on ${scenario}`,
    async () => {
      const child = fixture(initialDenial ? 77 : undefined)
      const socketPath = `/tmp/sck-fixture-${process.pid}-${crypto.randomUUID()}.sock`
      const server = await startMusicSessionServer(
        { socketPath },
        createFakeProvider(),
        {},
        (id, observations) =>
          sckPrototypeLayer(id, observations, child.boundary),
      )
      const model = createAudioVisualization({
        connect: () =>
          createMusicSessionClient({
            socketPath,
            clientId: "sck-sidebar",
            hostKind: "test",
            capabilities: [
              ...baselineCapabilities,
              ...audioVisualizationCapabilities,
            ],
          }),
        confirm: async () => true,
      })
      try {
        await model.chooseSource(async (list) => list.sources[0])
        expect(model.current().selected).not.toBeNull()
        expect(child.starts()).toBe(0)
        const started = model.start()
        await Effect.runPromise(Deferred.await(child.spawned))
        if (!initialDenial) child.frame(0)
        await started
        if (!initialDenial) {
          await waitFor(model, (state) => state.active && state.frame !== null)
          expect(model.current().frame?.spectrum).toEqual([0])
          if (scenario === "explicit-stop") await model.stop()
          else child.finish(scenario === "generic-stop" ? 1 : 77)
        }
        await waitFor(
          model,
          (state) =>
            !state.active &&
            state.frame === null &&
            (scenario === "explicit-stop" ||
              state.message.includes(
                scenario === "generic-stop" ? "setup" : "permission",
              )),
        )
        expect(child.starts()).toBe(1)
        expect(child.events).toEqual(["stop-io", "SIGTERM"])
      } finally {
        await model.dispose()
        await server.close()
      }
    },
  )
}
