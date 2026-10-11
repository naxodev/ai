/** Throwaway experiment. Never imported by a shipped entrypoint. */
import { Effect, Layer, Stream } from "effect"
import { fileURLToPath } from "node:url"
import {
  helperError,
  liveNativeHelperDependencies,
  type NativeHelperDependencies,
  type NativeHelperExit,
  type NativeHelperProcess,
} from "../../audio/helper-process.ts"
import {
  makeLocalKasetResolver,
  readLocalKasetCatalog,
  localKasetLayer,
} from "../../audio/local-kaset.ts"
import {
  AudioCapture,
  makeAudioCapture,
  type AudioCaptureAdapter,
  type AudioAdapterError,
} from "../../audio/capture.ts"
import { makeNativeHelperAdapter } from "../../audio/native-helper.ts"

export const sckHelperPath = fileURLToPath(
  new URL("./dist/sck-audio-helper", import.meta.url),
)
export const sckHelperIdentifier = "dev.naxo.music.sck-prototype"

/** Exit 77 is reserved for SCStreamErrorDomain.userDeclined after clean teardown. */
export const permissionAwareProcess = (
  child: NativeHelperProcess,
): NativeHelperProcess => ({
  ...child,
  // The original adapter races exit against stdout. Normalize only the clean,
  // explicit consent failure and deliver its typed error after stdout drains.
  exit: child.exit.pipe(
    Effect.map((exit) =>
      exit.code === 77 && exit.signal === null
        ? { code: 0, signal: null }
        : exit,
    ),
  ),
  stdout: child.stdout.pipe(
    Stream.concat(
      Stream.fromEffect(
        child.exit.pipe(
          Effect.flatMap((exit) =>
            exit.code === 77 && exit.signal === null
              ? Effect.fail(helperError("permission"))
              : Effect.void,
          ),
        ),
      ).pipe(Stream.drain),
    ),
  ),
})

export const sckDependencies = (
  boundary: NativeHelperDependencies = liveNativeHelperDependencies,
): NativeHelperDependencies => ({
  artifactPresent: () => boundary.artifactPresent(sckHelperPath),
  verify: () => boundary.verify(sckHelperPath, sckHelperIdentifier),
  spawn: (request) => {
    const child = boundary.spawn({ ...request, executable: sckHelperPath })
    return request.args[0] === "--list-kaset-sources"
      ? child
      : permissionAwareProcess(child)
  },
})

export const makeSckAdapter = (
  boundary: NativeHelperDependencies = liveNativeHelperDependencies,
): AudioCaptureAdapter => ({
  get availability() {
    return boundary.artifactPresent(sckHelperPath) ? "available" : "unavailable"
  },
  start: Effect.fn("SckPrototype.start")(function* (source) {
    let settledExit: NativeHelperExit | undefined
    const adapter = yield* makeNativeHelperAdapter(
      sckDependencies({
        ...boundary,
        spawn: (request) => {
          const child = boundary.spawn(request)
          return {
            ...child,
            exit: child.exit.pipe(
              Effect.tap((exit) =>
                Effect.sync(() => {
                  settledExit = exit
                }),
              ),
            ),
          }
        },
      }),
    )
    const classify = (error: AudioAdapterError) =>
      Effect.fail(
        settledExit?.code === 77 && settledExit.signal === null
          ? helperError("permission")
          : error.reason === "permission"
            ? helperError("setup")
            : error,
      )
    // The core supervisor joins physical exit before reporting these failures.
    // Consult that settled exit even when pipe/heartbeat errors bypass the
    // normal stdout tail. An unresolved exit never adds another shutdown wait.
    const handle = yield* adapter.start(source).pipe(Effect.catch(classify))
    return {
      frames: handle.frames.pipe(
        Stream.catch((error) =>
          Stream.fromEffect(classify(error)).pipe(Stream.drain),
        ),
      ),
    }
  }),
})

export const sckPrototypeLayer: typeof localKasetLayer = (
  id,
  observations,
  boundary,
) =>
  Layer.effect(
    AudioCapture,
    makeAudioCapture({
      daemonInstanceId: id,
      adapter: makeSckAdapter(boundary),
      resolver: makeLocalKasetResolver(() =>
        readLocalKasetCatalog(sckDependencies(boundary)),
      ),
      observations,
    }),
  )
