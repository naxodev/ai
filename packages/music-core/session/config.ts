import { Config, Context, Effect, Layer, Schema } from "effect"
import { createRequire } from "node:module"

const manifest = createRequire(import.meta.url)("../package.json") as {
  version: string
}
/** Single diagnostic version source: the published package manifest. */
export const PACKAGE_VERSION = manifest.version

export type MusicSessionOptions = {
  socketPath: string
  maxFrameBytes?: number
  commandQueueCapacity?: number
  reconciliationMs?: { transport: number; navigation: number }
  pollMs?: { playing: number; paused: number; idle: number }
}

export const defaults = {
  maxFrameBytes: 64 * 1024,
  commandQueueCapacity: 128,
  reconciliationMs: { transport: 120, navigation: 150 },
  pollMs: { playing: 3_000, paused: 5_000, idle: 8_000 },
} as const

export type ResolvedMusicSessionOptions = {
  readonly socketPath: string
  readonly maxFrameBytes: number
  readonly commandQueueCapacity: number
  readonly reconciliationMs: {
    readonly transport: number
    readonly navigation: number
  }
  readonly pollMs: {
    readonly playing: number
    readonly paused: number
    readonly idle: number
  }
}

export class MusicSessionConfigError extends Schema.TaggedErrorClass<MusicSessionConfigError>()(
  "MusicSession.ConfigError",
  { setting: Schema.String, operation: Schema.String, message: Schema.String },
) {}

const positiveSafeInteger = (
  setting: string,
  value: number,
): Effect.Effect<number, MusicSessionConfigError> =>
  Number.isSafeInteger(value) && value > 0
    ? Effect.succeed(value)
    : Effect.fail(
        new MusicSessionConfigError({
          setting,
          operation: "resolve",
          message: "must be a positive safe integer",
        }),
      )

const resolve = Effect.fn("MusicSession.Config.resolve")(function* (
  options: MusicSessionOptions,
) {
  if (!options.socketPath)
    return yield* Effect.fail(
      new MusicSessionConfigError({
        setting: "socketPath",
        operation: "resolve",
        message: "is required",
      }),
    )
  const maxFrameBytes = yield* positiveSafeInteger(
    "maxFrameBytes",
    options.maxFrameBytes ?? defaults.maxFrameBytes,
  )
  const commandQueueCapacity = yield* positiveSafeInteger(
    "commandQueueCapacity",
    options.commandQueueCapacity ?? defaults.commandQueueCapacity,
  )
  const transport = yield* positiveSafeInteger(
    "reconciliationMs.transport",
    options.reconciliationMs?.transport ?? defaults.reconciliationMs.transport,
  )
  const navigation = yield* positiveSafeInteger(
    "reconciliationMs.navigation",
    options.reconciliationMs?.navigation ??
      defaults.reconciliationMs.navigation,
  )
  const playing = yield* positiveSafeInteger(
    "pollMs.playing",
    options.pollMs?.playing ?? defaults.pollMs.playing,
  )
  const paused = yield* positiveSafeInteger(
    "pollMs.paused",
    options.pollMs?.paused ?? defaults.pollMs.paused,
  )
  const idle = yield* positiveSafeInteger(
    "pollMs.idle",
    options.pollMs?.idle ?? defaults.pollMs.idle,
  )
  return {
    socketPath: options.socketPath,
    maxFrameBytes,
    commandQueueCapacity,
    reconciliationMs: { transport, navigation },
    pollMs: { playing, paused, idle },
  } satisfies ResolvedMusicSessionOptions
})

/** The daemon configuration is acquired once and injected into every worker. */
export class MusicSessionConfig extends Context.Service<
  MusicSessionConfig,
  { readonly options: ResolvedMusicSessionOptions }
>()("@naxodev/music-core/MusicSessionConfig") {}

export const layer = (options: MusicSessionOptions) =>
  Layer.effect(
    MusicSessionConfig,
    resolve(options).pipe(
      Effect.map((resolved) => MusicSessionConfig.of({ options: resolved })),
    ),
  )

// Each setting remains an explicit Config recipe: defaults only cover absence;
// conversion and refinement are performed by the same `resolve` boundary above.
const socketPathConfig = Config.string("MUSIC_SESSION_SOCKET")
const optionalNumber = (name: string, fallback: number) =>
  Config.string(name).pipe(Config.withDefault(String(fallback)))

export const layerFromConfig = Layer.effect(
  MusicSessionConfig,
  Effect.gen(function* () {
    const configError = (setting: string, cause: unknown) =>
      new MusicSessionConfigError({
        setting,
        operation: "read",
        message: cause instanceof Error ? cause.message : String(cause),
      })
    const read = (setting: string, config: Config.Config<string>) =>
      config.pipe(Effect.mapError((cause) => configError(setting, cause)))
    const number = (setting: string, config: Config.Config<string>) =>
      read(setting, config).pipe(Effect.map(Number))
    const options = yield* Effect.all({
      socketPath: read("socketPath", socketPathConfig),
      maxFrameBytes: number(
        "maxFrameBytes",
        optionalNumber("MUSIC_SESSION_MAX_FRAME_BYTES", defaults.maxFrameBytes),
      ),
      commandQueueCapacity: number(
        "commandQueueCapacity",
        optionalNumber(
          "MUSIC_SESSION_COMMAND_QUEUE_CAPACITY",
          defaults.commandQueueCapacity,
        ),
      ),
      transport: number(
        "reconciliationMs.transport",
        optionalNumber(
          "MUSIC_SESSION_RECONCILIATION_TRANSPORT_MS",
          defaults.reconciliationMs.transport,
        ),
      ),
      navigation: number(
        "reconciliationMs.navigation",
        optionalNumber(
          "MUSIC_SESSION_RECONCILIATION_NAVIGATION_MS",
          defaults.reconciliationMs.navigation,
        ),
      ),
      playing: number(
        "pollMs.playing",
        optionalNumber(
          "MUSIC_SESSION_POLL_PLAYING_MS",
          defaults.pollMs.playing,
        ),
      ),
      paused: number(
        "pollMs.paused",
        optionalNumber("MUSIC_SESSION_POLL_PAUSED_MS", defaults.pollMs.paused),
      ),
      idle: number(
        "pollMs.idle",
        optionalNumber("MUSIC_SESSION_POLL_IDLE_MS", defaults.pollMs.idle),
      ),
    })
    const resolved = yield* resolve({
      socketPath: options.socketPath,
      maxFrameBytes: options.maxFrameBytes,
      commandQueueCapacity: options.commandQueueCapacity,
      reconciliationMs: {
        transport: options.transport,
        navigation: options.navigation,
      },
      pollMs: {
        playing: options.playing,
        paused: options.paused,
        idle: options.idle,
      },
    })
    return MusicSessionConfig.of({ options: resolved })
  }),
)

/** Compatibility helper for the outer Promise/socket boundary. */
export const resolveConfig = (options: MusicSessionOptions) =>
  Effect.runPromise(resolve(options))
