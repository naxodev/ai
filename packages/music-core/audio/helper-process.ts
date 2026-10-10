import { Buffer } from "node:buffer"
import { execFile, spawn } from "node:child_process"
import { lstatSync } from "node:fs"
import type { Readable } from "node:stream"
import { Deferred, Effect, Exit, Stream } from "effect"
import { AudioAdapterError } from "./capture.ts"
import { localMonotonicMs } from "./clock.ts"
import { AUDIO_CLOCK_DOMAIN } from "./schema.ts"

export type NativeHelperExit = {
  readonly code: number | null
  readonly signal: string | null
}

export type NativeHelperSpawnRequest = {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly shell: false
}

/** Spawn returns ownership synchronously, before waiting for readiness. */
export type NativeHelperProcess = {
  readonly ready: Effect.Effect<void, AudioAdapterError>
  readonly stdout: Stream.Stream<Uint8Array, AudioAdapterError>
  readonly stderr: Stream.Stream<Uint8Array, AudioAdapterError>
  /** Completes only after the actual child and its pipes have closed. */
  readonly exit: Effect.Effect<NativeHelperExit>
  readonly heartbeat: Effect.Effect<void, AudioAdapterError>
  readonly stopIO: () => void
  readonly signal: (signal: "SIGTERM" | "SIGKILL") => void
}

/** Trusted test boundaries. Neither seam is an executable-path setting. */
export type NativeHelperDependencies = {
  /**
   * Cheap synchronous artifact check for the availability gate. It must not
   * run cryptographic verification, because availability is read while listing
   * sources and must not cache a stale rejection.
   */
  readonly artifactPresent: (executable: string) => boolean
  readonly verify: (
    executable: string,
    identifier: string,
  ) => Effect.Effect<boolean, AudioAdapterError>
  readonly spawn: (request: NativeHelperSpawnRequest) => NativeHelperProcess
}

export const helperError = (reason: AudioAdapterError["reason"] = "setup") =>
  new AudioAdapterError({ reason })

export const helperProcessError = (cause: unknown) =>
  helperError(
    typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (cause.code === "EACCES" || cause.code === "EPERM")
      ? "permission"
      : "setup",
  )

export const cleanHelperExit = (exit: NativeHelperExit) =>
  exit.code === 0 && exit.signal === null

const readBytes = 4_096
const shutdownMs = 1_000

// Pull fixed-size chunks. Node's pipe backpressure bounds unread bytes.
const readPipe = (
  pipe: Readable,
): Stream.Stream<Uint8Array, AudioAdapterError> =>
  Stream.unfold(undefined, () =>
    Effect.callback<
      readonly [Uint8Array, undefined] | undefined,
      AudioAdapterError
    >((resume) => {
      let settled = false
      const cleanup = () => {
        settled = true
        pipe.off("readable", pull)
        pipe.off("end", end)
        pipe.off("close", pull)
        pipe.off("error", fail)
      }
      const complete = (
        result: Effect.Effect<
          readonly [Uint8Array, undefined] | undefined,
          AudioAdapterError
        >,
      ) => {
        if (settled) return
        // callback's returned effect handles interruption, not normal completion.
        // Remove listeners before resuming so an old reader cannot steal bytes.
        cleanup()
        resume(result)
      }
      const pull = () => {
        if (settled) return
        try {
          const chunk: unknown = pipe.read(
            Math.max(1, Math.min(readBytes, pipe.readableLength)),
          )
          if (Buffer.isBuffer(chunk))
            complete(Effect.succeed([chunk, undefined] as const))
          else if (chunk !== null) complete(Effect.fail(helperError()))
          else if (pipe.readableEnded || pipe.destroyed)
            complete(Effect.succeed(undefined))
        } catch (cause) {
          complete(Effect.fail(helperProcessError(cause)))
        }
      }
      const end = () => complete(Effect.succeed(undefined))
      const fail = (cause: unknown) =>
        complete(Effect.fail(helperProcessError(cause)))
      pipe.on("readable", pull)
      pipe.on("end", end)
      // Explicit teardown may close a pipe without emitting end.
      pipe.on("close", pull)
      pipe.on("error", fail)
      pull()
      return Effect.sync(cleanup)
    }),
  )

type VerificationBoundary = {
  readonly regularFile: (executable: string) => boolean
  readonly codesign: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<boolean, AudioAdapterError>
}

/** Internal verification policy, with offline filesystem/command boundaries. */
export const makeHelperVerifier = (
  boundary: VerificationBoundary,
): NativeHelperDependencies["verify"] =>
  Effect.fn("NativeHelper.verify")(function* (
    executable: string,
    identifier: string,
  ) {
    const regular = yield* Effect.try({
      try: () => boundary.regularFile(executable),
      catch: () => helperError("unavailable"),
    })
    if (!regular) return false
    // The requirement verifies identity and integrity. "=" marks an inline
    // expression; without it, codesign tries to read a requirement file.
    return yield* boundary.codesign([
      "--verify",
      "--strict",
      "-R",
      `=identifier "${identifier}"`,
      executable,
    ])
  })

const liveVerifier = makeHelperVerifier({
  regularFile: (executable) => lstatSync(executable).isFile(),
  codesign: (args) =>
    Effect.tryPromise({
      try: (signal) =>
        new Promise<boolean>((resolve) => {
          execFile(
            "/usr/bin/codesign",
            [...args],
            {
              signal,
              timeout: 5_000,
              maxBuffer: readBytes,
              shell: false,
            },
            (failure) => resolve(failure === null),
          )
        }),
      catch: () => helperError("unavailable"),
    }),
})

export const liveNativeHelperDependencies: NativeHelperDependencies = {
  artifactPresent: (executable) => {
    if (process.platform !== "darwin") return false
    try {
      return lstatSync(executable).isFile()
    } catch {
      // An unreadable or absent path is simply not a usable helper artifact.
      return false
    }
  },
  verify: (executable, identifier) =>
    process.platform === "darwin"
      ? liveVerifier(executable, identifier)
      : Effect.succeed(false),
  spawn: (request) => {
    const child = spawn(request.executable, [...request.args], {
      // A literal false, not the request field: no shell may ever be involved.
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const ready = Deferred.makeUnsafe<void, AudioAdapterError>()
    const exit = Deferred.makeUnsafe<NativeHelperExit>()
    const fault = Deferred.makeUnsafe<never, AudioAdapterError>()
    child.once("spawn", () => Deferred.doneUnsafe(ready, Effect.void))
    child.on("error", (cause) => {
      const failure = Effect.fail(helperProcessError(cause))
      Deferred.doneUnsafe(ready, failure)
      Deferred.doneUnsafe(fault, failure)
    })
    child.once("close", (code, signal) =>
      Deferred.doneUnsafe(exit, Effect.succeed({ code, signal })),
    )
    // Pipe errors can occur outside an active read/write. Keep them typed.
    const pipeError = (cause: unknown) =>
      Deferred.doneUnsafe(fault, Effect.fail(helperProcessError(cause)))
    child.stdin.on("error", pipeError)
    child.stdout.on("error", pipeError)
    child.stderr.on("error", pipeError)
    return {
      ready: Deferred.await(ready),
      stdout: readPipe(child.stdout).pipe(
        Stream.interruptWhen(Deferred.await(fault)),
      ),
      stderr: readPipe(child.stderr).pipe(
        Stream.interruptWhen(Deferred.await(fault)),
      ),
      exit: Deferred.await(exit),
      heartbeat: Effect.callback<void, AudioAdapterError>((resume) => {
        try {
          const line = `${JSON.stringify({
            type: "heartbeat",
            clockDomain: AUDIO_CLOCK_DOMAIN,
            timestampMs: localMonotonicMs(),
          })}\n`
          child.stdin.write(line, (failure) =>
            resume(
              failure ? Effect.fail(helperProcessError(failure)) : Effect.void,
            ),
          )
        } catch (cause) {
          resume(Effect.fail(helperProcessError(cause)))
        }
      }),
      stopIO: () => {
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
      },
      signal: (signal) => {
        if (
          child.pid !== undefined &&
          child.exitCode === null &&
          child.signalCode === null &&
          !child.kill(signal)
        )
          throw new Error("helper signal was not delivered")
      },
    }
  },
}

/** Internal lifecycle primitive, exported here for direct concurrency tests. */
export const makeHelperTermination = (process: NativeHelperProcess) =>
  Effect.cached(
    Effect.uninterruptible(
      Effect.gen(function* () {
        // A failed I/O teardown must not skip signaling or waiting for the child.
        const stopped = yield* Effect.try({
          try: process.stopIO,
          catch: helperProcessError,
        }).pipe(Effect.exit)
        const signaled = yield* Effect.try({
          try: () => process.signal("SIGTERM"),
          catch: helperProcessError,
        }).pipe(Effect.exit)
        const normal = yield* process.exit.pipe(
          Effect.map((exit) => ({ type: "exited" as const, exit })),
          Effect.timeoutOrElse({
            duration: shutdownMs,
            orElse: () => Effect.succeed({ type: "timeout" as const }),
          }),
        )
        if (normal.type === "timeout") {
          yield* Effect.try({
            try: () => process.signal("SIGKILL"),
            catch: helperProcessError,
          })
          yield* process.exit.pipe(
            Effect.timeoutOrElse({
              duration: shutdownMs,
              orElse: () => Effect.fail(helperError("timeout")),
            }),
          )
          // Hard kill does not prove native resources were torn down.
          return yield* Effect.fail(helperError())
        }
        if (Exit.isFailure(stopped))
          return yield* Effect.failCause(stopped.cause)
        if (Exit.isFailure(signaled))
          return yield* Effect.failCause(signaled.cause)
        // A signal exit, native teardown failure, or hard watchdog cannot prove
        // cleanup. A handled SIGTERM exits normally after the native defer.
        // Other abnormal exits belong to the stream supervisor, after reaping.
        if (
          normal.exit.signal !== null ||
          normal.exit.code === 70 ||
          normal.exit.code === 125
        )
          return yield* Effect.fail(helperError())
      }),
    ),
  ).pipe(Effect.map((terminate) => Effect.uninterruptible(terminate)))
