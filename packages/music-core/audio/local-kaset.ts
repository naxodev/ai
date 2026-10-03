import { Buffer } from "node:buffer"
import { Cause, Effect, Layer, Result, Schema, Stream } from "effect"
import {
  AudioCapture,
  makeAudioCapture,
  type AudioAdapterError,
} from "./capture.ts"
import {
  cleanHelperExit,
  helperError,
  liveNativeHelperDependencies,
  makeHelperTermination,
  type NativeHelperDependencies,
} from "./helper-process.ts"
import {
  makeNativeHelperAdapter,
  nativeAudioHelperIdentifier,
  nativeAudioHelperPath,
} from "./native-helper.ts"
import {
  NativeCaptureIdentity,
  sameCaptureIdentity,
  type ResolvedCaptureSource,
} from "./schema.ts"
import type {
  AudioSourceResolver,
  ProviderSourceObservation,
} from "./source.ts"

const metadataLimit = 64 * 1024
const NativeKasetCatalog = Schema.Struct({
  sources: Schema.Array(
    Schema.Struct({
      identity: NativeCaptureIdentity,
      runningOutput: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(32)),
})

const parseCatalog = (text: string) => {
  try {
    const value: unknown = JSON.parse(text)
    const decoded = Schema.decodeUnknownResult(NativeKasetCatalog)(value)
    return Result.isSuccess(decoded) ? decoded.success : undefined
  } catch {
    return undefined
  }
}

/** Fixed metadata command. This never creates a tap or renews a capture lease. */
export const readLocalKasetCatalog = (
  dependencies: NativeHelperDependencies = liveNativeHelperDependencies,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const trusted = yield* dependencies.verify(
        nativeAudioHelperPath,
        nativeAudioHelperIdentifier,
      )
      if (!trusted) return yield* Effect.fail(helperError("unavailable"))
      const child = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const process = yield* Effect.try({
            try: () =>
              dependencies.spawn({
                executable: nativeAudioHelperPath,
                args: ["--list-kaset-sources"],
                shell: false,
              }),
            catch: () => helperError("unavailable"),
          })
          const terminate = yield* makeHelperTermination(process)
          yield* Effect.addFinalizer(() => terminate.pipe(Effect.orDie))
          return process
        }),
      )
      yield* child.ready
      // Drain diagnostics without retaining paths or private metadata.
      yield* child.stderr.pipe(Stream.runDrain, Effect.forkScoped)
      const bytes = Buffer.alloc(metadataLimit)
      let length = 0
      yield* child.stdout.pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            if (length + chunk.byteLength > bytes.length)
              return yield* Effect.fail(helperError("unavailable"))
            bytes.set(chunk, length)
            length += chunk.byteLength
          }),
        ),
      )
      if (!cleanHelperExit(yield* child.exit))
        return yield* Effect.fail(helperError("unavailable"))
      const catalog = parseCatalog(bytes.subarray(0, length).toString("utf8"))
      if (!catalog) return yield* Effect.fail(helperError("unavailable"))
      return catalog
    }).pipe(Effect.timeout("3 seconds")),
  ).pipe(
    // Metadata failure grants no authority. Preserve cancellation and report
    // unavailable, including an abnormal exit from this tap-free command.
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.fail(helperError("unavailable")),
    ),
  )

/** Metadata seam for offline tests. A read cannot itself authorize capture. */
export const makeLocalKasetResolver = (
  read: () => Effect.Effect<unknown, AudioAdapterError> = () =>
    readLocalKasetCatalog(),
): AudioSourceResolver => {
  const candidate = Effect.fn("LocalKaset.candidate")(function* () {
    const value = yield* read().pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    )
    const decoded = Schema.decodeUnknownResult(NativeKasetCatalog)(value)
    if (Result.isFailure(decoded)) return { available: false as const }
    // Ambiguity includes silent helpers. Never choose the first active PID.
    if (decoded.success.sources.length !== 1)
      return { available: true as const }
    const entry = decoded.success.sources[0]
    if (entry === undefined) return { available: true as const }
    const identity = entry.identity
    if (
      identity.processIdentifier > 2_147_483_647 ||
      !/^\d+:\d+$/.test(identity.launchIdentity) ||
      !/^\/[^|]+\|(?:[0-9a-f]{2}){1,64}$/.test(identity.executableIdentity) ||
      !/^[1-9]\d*$/.test(identity.coreAudioObject) ||
      Number(identity.coreAudioObject) > 4_294_967_295
    )
      return { available: false as const }
    const source: ResolvedCaptureSource = {
      mode: "process",
      identity,
      observationSequence: 0,
      attribution: "kaset-cache-v1",
      label: `Kaset (WebKit) · PID ${identity.processIdentifier}`,
      capabilities: {
        spectrum: "measured",
        envelope: "measured",
        channels: "stereo",
      },
    }
    return {
      available: true as const,
      source,
      runningOutput: entry.runningOutput,
    }
  })
  const revalidate = Effect.fn("LocalKaset.revalidate")(function* (
    source: ResolvedCaptureSource,
  ) {
    if (
      source.mode !== "process" ||
      source.attribution !== "kaset-cache-v1" ||
      source.identity.kind !== "native"
    )
      return undefined
    const current = yield* candidate()
    // Return a changed identity at the same PID so the owner can report PID reuse.
    return current.source?.identity.kind === "native" &&
      current.source.identity.processIdentifier ===
        source.identity.processIdentifier
      ? current.source
      : undefined
  })
  return {
    list: Effect.fn("LocalKaset.list")(function* () {
      const current = yield* candidate()
      if (!current.available)
        return {
          availability: "unavailable" as const,
          reason: "capture-adapter-unavailable" as const,
          sources: [],
        }
      return {
        availability: "available" as const,
        sources:
          current.source && current.runningOutput ? [current.source] : [],
      }
    }),
    revalidate,
    confirm: Effect.fn("LocalKaset.confirm")(function* (active) {
      const current = yield* revalidate(active)
      if (!current) return "unresolved" as const
      return sameCaptureIdentity(active.identity, current.identity)
        ? ("same" as const)
        : ("changed" as const)
    }),
  }
}

/** Explicit local graph only. Construction and subscription never start capture. */
export const localKasetLayer = (
  daemonInstanceId: string,
  observations: Stream.Stream<ProviderSourceObservation>,
  dependencies: NativeHelperDependencies = liveNativeHelperDependencies,
) =>
  Layer.effect(
    AudioCapture,
    Effect.gen(function* () {
      const adapter = yield* makeNativeHelperAdapter(dependencies)
      return yield* makeAudioCapture({
        daemonInstanceId,
        adapter,
        resolver: makeLocalKasetResolver(() =>
          readLocalKasetCatalog(dependencies),
        ),
        observations,
      })
    }),
  )
