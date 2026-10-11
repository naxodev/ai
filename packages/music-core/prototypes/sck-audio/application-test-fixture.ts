/** Fake process boundaries only. Never executes an installed application or helper. */
import { expect } from "bun:test"
import { Buffer } from "node:buffer"
import { Deferred, Effect, Stream } from "effect"
import {
  helperError,
  type NativeHelperDependencies,
  type NativeHelperExit,
  type NativeHelperProcess,
} from "../../audio/helper-process.ts"
export const witness = {
  kind: "native",
  processIdentifier: 42,
  launchIdentity: "100:0",
  executableIdentity: "/fixture|abcdef12",
  coreAudioObject: "99",
}
export const application = {
  processIdentifier: 31415,
  launchIdentity: "200:0",
  executableIdentity:
    "/Applications/Kaset.app/Contents/MacOS/Kaset|" + "a".repeat(40),
}
export const preflight = {
  event: "sck-application-preflight",
  scope: "kaset-application",
  identity: application,
}
export function makeApplicationFixture(
  profile: {
    helperPath: string
    helperIdentifier: string
    preflightFlag: string
    nativeFlag: string
  },
  summary: Readonly<Record<string, unknown>>,
  options: {
    witnesses?: number
    preflight?: string
    metadata?: Readonly<Record<string, string>>
    payload?: string
    code?: number
    fault?: "stdout" | "heartbeat" | "cleanup"
    pending?: boolean
    trusted?: boolean
  } = {},
) {
  const calls: string[][] = []
  const events: string[] = []
  const spawned = Deferred.makeUnsafe<void>()
  const exit = Deferred.makeUnsafe<NativeHelperExit>()
  if (!options.pending)
    Deferred.doneUnsafe(
      exit,
      Effect.succeed({ code: options.code ?? 0, signal: null }),
    )
  const completed = (payload: string): NativeHelperProcess => ({
    ready: Effect.void,
    stdout: Stream.make(Buffer.from(payload)),
    stderr: Stream.empty,
    exit: Effect.succeed({ code: 0, signal: null }),
    heartbeat: Effect.void,
    stopIO: () => {},
    signal: () => {},
  })
  const child: NativeHelperProcess = {
    ...completed(
      options.payload ??
        JSON.stringify({ ...summary, privatePath: "/private/window/title" }),
    ),
    stdout:
      options.fault === "stdout"
        ? Stream.fail(helperError())
        : options.pending || options.fault === "heartbeat"
          ? Stream.never
          : Stream.make(
              Buffer.from(
                options.payload ??
                  JSON.stringify({
                    ...summary,
                    privatePath: "/private/window/title",
                  }),
              ),
            ),
    stderr:
      options.code === 77
        ? Stream.make(
            Buffer.from(
              '{"event":"music-audio-helper-stop","reason":"permission"}\n',
            ),
          )
        : Stream.empty,
    exit: Deferred.await(exit),
    heartbeat:
      options.fault === "heartbeat" ? Effect.fail(helperError()) : Effect.void,
    stopIO: () => {
      events.push("stop-io")
      if (options.fault === "cleanup") throw new Error("cleanup failed")
    },
    signal: (signal) => {
      events.push(signal)
      Deferred.doneUnsafe(exit, Effect.succeed({ code: null, signal }))
    },
  }
  const boundary: NativeHelperDependencies = {
    artifactPresent: () => true,
    verify: (path, identifier) =>
      Effect.sync(() => {
        expect(path).toBe(profile.helperPath)
        expect(identifier).toBe(profile.helperIdentifier)
        return options.trusted !== false
      }),
    spawn: (request) => {
      expect(request.executable).toBe(profile.helperPath)
      expect(request.shell).toBe(false)
      calls.push([...request.args])
      const metadata = options.metadata?.[request.args[0] ?? ""]
      if (metadata !== undefined) return completed(metadata)
      if (request.args[0] === "--list-kaset-sources")
        return completed(
          JSON.stringify({
            sources: Array.from({ length: options.witnesses ?? 1 }, () => ({
              identity: witness,
              runningOutput: false,
            })),
          }),
        )
      if (request.args[0] === profile.preflightFlag)
        return completed(options.preflight ?? JSON.stringify(preflight))
      expect(request.args[0]).toBe(profile.nativeFlag)
      Deferred.doneUnsafe(spawned, Effect.void)
      return child
    },
  }
  return {
    boundary,
    calls,
    events,
    spawned,
    claim: Effect.sync(() => {
      events.push("claim")
    }),
  }
}
