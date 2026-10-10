import { Buffer } from "node:buffer"
import { fileURLToPath } from "node:url"
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Queue,
  Ref,
  Result,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect"
import { type AudioCaptureAdapter, AudioAdapterError } from "./capture.ts"
import {
  cleanHelperExit,
  helperError,
  liveNativeHelperDependencies,
  makeHelperTermination,
  helperProcessError,
  type NativeHelperDependencies,
} from "./helper-process.ts"
import {
  AudioFeatureDraft,
  MAX_AUDIO_FEATURE_FRAME_BYTES,
  type ResolvedCaptureSource,
} from "./schema.ts"

export type {
  NativeHelperDependencies,
  NativeHelperExit,
  NativeHelperProcess,
  NativeHelperSpawnRequest,
} from "./helper-process.ts"

export const nativeAudioHelperPath = fileURLToPath(
  new URL("../audio/native/music-audio-helper", import.meta.url),
)
export const nativeAudioHelperIdentifier = "dev.naxo.music.audio-helper"
const leaseMs = 5_000
const heartbeatMs = 2_000
const monotonicMs = Clock.monotonicTimeNanos.pipe(
  Effect.map((nanos) => Number(nanos) / 1_000_000),
)

const verified = (dependencies: NativeHelperDependencies) =>
  dependencies.verify(nativeAudioHelperPath, nativeAudioHelperIdentifier).pipe(
    Effect.timeoutOrElse({
      duration: leaseMs,
      orElse: () => Effect.succeed(false),
    }),
    // Verification failure means unavailable, never permission to spawn.
    Effect.catch(() => Effect.succeed(false)),
  )

/**
 * Decode one helper line at the boundary. Malformed JSON and a schema mismatch
 * are the same typed rejection, never a defect and never a partial draft.
 */
const parseFrameLine = (text: string): AudioFeatureDraft | undefined => {
  try {
    const parsed: unknown = JSON.parse(text)
    const decoded = Schema.decodeUnknownResult(AudioFeatureDraft)(parsed)
    return Result.isSuccess(decoded) ? decoded.success : undefined
  } catch {
    // A malformed line is untrusted helper output, not a caller defect.
    return undefined
  }
}

/**
 * Local-only process adapter. The default daemon still uses unavailableLayer.
 * Readiness requires a valid first draft, not merely a successful spawn.
 * Heartbeats anchor native sample time conservatively to the parent's clock.
 * Signed distribution and live integration remain release gates.
 */
export const makeNativeHelperAdapter = Effect.fn("NativeHelper.makeAdapter")(
  function* (
    dependencies: NativeHelperDependencies = liveNativeHelperDependencies,
  ) {
    const start = Effect.fn("NativeHelper.start")(function* (
      source: ResolvedCaptureSource,
    ) {
      const trusted = yield* verified(dependencies)
      if (!trusted) return yield* Effect.fail(helperError("unavailable"))
      if (source.identity.kind !== "native")
        return yield* Effect.fail(helperError())
      const identity = source.identity
      const owner = yield* Scope.Scope
      const frames = yield* Queue.sliding<
        AudioFeatureDraft,
        AudioAdapterError | Cause.Done
      >(1)
      const usable = yield* Deferred.make<void, AudioAdapterError>()
      const progress = yield* Ref.make(yield* monotonicMs)
      const { process, terminate } = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const process = yield* Effect.try({
            try: () =>
              dependencies.spawn({
                executable: nativeAudioHelperPath,
                shell: false,
                args: [
                  "--protocol",
                  "1",
                  "--process-id",
                  String(identity.processIdentifier),
                  "--launch-identity",
                  identity.launchIdentity,
                  "--executable-identity",
                  identity.executableIdentity,
                  "--core-audio-object",
                  identity.coreAudioObject,
                  ...(source.attribution === "kaset-cache-v1"
                    ? ["--attribution", source.attribution]
                    : []),
                ],
              }),
            catch: helperProcessError,
          })
          const terminate = yield* makeHelperTermination(process)
          // Register before any interruptible readiness wait. No acquireRelease.
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              // Scope closure can precede worker registration. Settle startup and
              // external stream readers even when that worker never ran.
              yield* Deferred.fail(usable, helperError())
              yield* Queue.fail(frames, helperError())
              yield* terminate.pipe(Effect.orDie)
            }),
          )
          return { process, terminate }
        }),
      )

      const deadline = Effect.gen(function* () {
        for (;;) {
          const remaining =
            (yield* Ref.get(progress)) + leaseMs - (yield* monotonicMs)
          if (remaining <= 0) return yield* Effect.fail(helperError("timeout"))
          yield* Effect.sleep(remaining)
        }
      })
      const output = Effect.gen(function* () {
        // Fixed allocation bounds a partial line, including newline-free output.
        const line = Buffer.alloc(MAX_AUDIO_FEATURE_FRAME_BYTES)
        let length = 0
        yield* process.stdout.pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              for (const byte of chunk) {
                if (byte !== 10) {
                  if (length === line.length)
                    return yield* Effect.fail(helperError())
                  line[length++] = byte
                  continue
                }
                const draft = parseFrameLine(
                  line.subarray(0, length).toString("utf8"),
                )
                length = 0
                if (draft === undefined)
                  return yield* Effect.fail(helperError())
                yield* Ref.set(progress, yield* monotonicMs)
                yield* Queue.offer(frames, draft)
                yield* Deferred.succeed(usable, undefined)
              }
            }),
          ),
        )
        if (length !== 0) return yield* Effect.fail(helperError())
        const exited = yield* process.exit
        if (!cleanHelperExit(exited))
          return yield* Effect.fail(
            helperError(
              exited.code === 124 || exited.code === 125 ? "timeout" : "setup",
            ),
          )
        if (!Deferred.isDoneUnsafe(usable))
          return yield* Effect.fail(helperError())
      })
      const diagnostics = process.stderr.pipe(
        // Retain no text or control data. Saturate the private diagnostic counter.
        Stream.runFold(
          () => 0,
          (bytes, chunk) => Math.min(4_096, bytes + chunk.byteLength),
        ),
        Effect.andThen(Effect.never),
      )
      const abnormalExit = process.exit.pipe(
        Effect.flatMap((exited) => {
          if (cleanHelperExit(exited)) return Effect.never
          return Effect.fail(
            helperError(
              exited.code === 124 || exited.code === 125 ? "timeout" : "setup",
            ),
          )
        }),
      )
      const run = Effect.raceFirst(
        process.ready.pipe(
          Effect.andThen(
            Effect.raceFirst(
              output,
              Effect.raceFirst(
                process.heartbeat.pipe(
                  Effect.repeat(Schedule.spaced(heartbeatMs)),
                ),
                diagnostics,
              ),
            ),
          ),
        ),
        abnormalExit,
      )
      yield* Effect.raceFirst(run, deadline).pipe(
        Effect.onExit(() => terminate),
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (Exit.isFailure(exit)) {
              yield* Deferred.failCause(usable, exit.cause)
              yield* Queue.failCause(frames, exit.cause)
            } else yield* Queue.end(frames)
          }),
        ),
        Effect.forkIn(owner),
      )
      yield* Deferred.await(usable)
      return { frames: Stream.fromQueue(frames) }
    })
    return {
      // Availability reports only that a helper artifact exists, so a helper
      // installed after daemon start stays listable. Cryptographic
      // verification is the authoritative gate and runs before every spawn.
      get availability() {
        return dependencies.artifactPresent(nativeAudioHelperPath)
          ? "available"
          : "unavailable"
      },
      start,
    } satisfies AudioCaptureAdapter
  },
)
