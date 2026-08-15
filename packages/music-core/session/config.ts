import { Config, Context, Effect, Layer, Schema } from "effect"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { lstat, mkdir, readFile, unlink } from "node:fs/promises"
import type { Stats } from "node:fs"

const manifest = createRequire(import.meta.url)("../package.json") as {
  version: string
}
/** Single diagnostic version source: the published package manifest. */
export const PACKAGE_VERSION = manifest.version

const MACOS_UNIX_PATH_BYTES = 104

export class MusicSessionRuntimeError extends Schema.TaggedErrorClass<MusicSessionRuntimeError>()(
  "MusicSession.RuntimeError",
  {
    operation: Schema.String,
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const runtimeError = (operation: string, path: string, cause: unknown) =>
  new MusicSessionRuntimeError({
    operation,
    path,
    message: cause instanceof Error ? cause.message : String(cause),
    cause: { cause },
  })

export type MusicSessionRuntimePaths = {
  readonly directory: string
  readonly socketPath: string
  readonly markerPath: string
  readonly uid: number
}

/** Test-only arguments; production calls this with no arguments. */
export type RuntimeDependencies = {
  readonly lstat?: typeof lstat
  readonly mkdir?: typeof mkdir
  readonly readFile?: typeof readFile
  readonly unlink?: typeof unlink
  /** Throws the platform process-check error, exactly like `process.kill(pid, 0)`. */
  readonly processExists?: (pid: number) => void
}

const runtimeDependencies = new WeakMap<
  MusicSessionRuntimePaths,
  RuntimeDependencies
>()
const runtimeIo = (paths: MusicSessionRuntimePaths) =>
  runtimeDependencies.get(paths) ?? {}

export type RuntimePathResolverOptions = {
  readonly root?: string
  readonly uid?: number
  /** Narrow test seam for filesystem and process observations. */
  readonly dependencies?: RuntimeDependencies
}

/** Resolves the compact, same-user production layout without consulting env. */
export const resolveMusicSessionRuntimePaths = (
  options: RuntimePathResolverOptions = {},
): MusicSessionRuntimePaths => {
  const uid = options.uid ?? process.getuid?.()
  const root = options.root ?? "/tmp"
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0)
    throw runtimeError("resolve", root, "a numeric process UID is required")
  if (!root.startsWith("/"))
    throw runtimeError("resolve", root, "runtime root must be absolute")
  const directory = join(root, `naxodev-music-${uid}`)
  const socketPath = join(directory, "s.sock")
  if (Buffer.byteLength(socketPath, "utf8") + 1 > MACOS_UNIX_PATH_BYTES)
    throw runtimeError("resolve", socketPath, "Unix socket path is too long")
  const paths = {
    directory,
    socketPath,
    markerPath: join(directory, "start.lock"),
    uid,
  }
  if (options.dependencies) runtimeDependencies.set(paths, options.dependencies)
  return paths
}

export type MusicSessionOptions = {
  socketPath?: string
  /** Narrow test seam; production callers use the resolver's /tmp default. */
  runtime?: MusicSessionRuntimePaths
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
  /** Present only for the secure default, never inferred from a path string. */
  readonly runtime: MusicSessionRuntimePaths | undefined
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
  let runtime: MusicSessionRuntimePaths | undefined = options.runtime
  let socketPath = options.socketPath ?? runtime?.socketPath
  if (socketPath === undefined) {
    try {
      runtime = resolveMusicSessionRuntimePaths()
      socketPath = runtime.socketPath
    } catch (cause) {
      return yield* Effect.fail(
        new MusicSessionConfigError({
          setting: "socketPath",
          operation: "resolve",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      )
    }
  }
  if (runtime && socketPath !== runtime.socketPath)
    return yield* Effect.fail(
      new MusicSessionConfigError({
        setting: "socketPath",
        operation: "resolve",
        message: "managed runtime socket path cannot be overridden",
      }),
    )
  if (!socketPath || !socketPath.startsWith("/"))
    return yield* Effect.fail(
      new MusicSessionConfigError({
        setting: "socketPath",
        operation: "resolve",
        message: "must be an absolute Unix socket path",
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
    socketPath,
    runtime,
    maxFrameBytes,
    commandQueueCapacity,
    reconciliationMs: { transport, navigation },
    pollMs: { playing, paused, idle },
  } satisfies ResolvedMusicSessionOptions
})

export class MusicSessionConfig extends Context.Service<
  MusicSessionConfig,
  { readonly options: ResolvedMusicSessionOptions }
>()("@naxodev/music-core/MusicSessionConfig") {}
export const layer = (options: MusicSessionOptions) =>
  Layer.effect(
    MusicSessionConfig,
    resolve(options).pipe(
      Effect.map((options) => MusicSessionConfig.of({ options })),
    ),
  )

const socketPathConfig = Config.string("MUSIC_SESSION_SOCKET").pipe(
  Config.withDefault(""),
)
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
      ...(options.socketPath ? { socketPath: options.socketPath } : {}),
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

const sameOwner = (stat: Stats, uid: number) => stat.uid === uid
const hasExactMode = (stat: Stats, mode: number) => (stat.mode & 0o777) === mode
const identity = (path: string, stat: Stats) => ({
  path,
  dev: stat.dev,
  ino: stat.ino,
  mode: stat.mode,
  uid: stat.uid,
})
type ArtifactProof = ReturnType<typeof identity> & {
  readonly kind: "socket" | "marker"
}

const validateDirectory = (paths: MusicSessionRuntimePaths, stat: Stats) => {
  if (
    !stat.isDirectory() ||
    !sameOwner(stat, paths.uid) ||
    !hasExactMode(stat, 0o700)
  )
    throw runtimeError(
      "prepare",
      paths.directory,
      "runtime directory must be an owner-only directory owned by this user",
    )
}

/** Acquires a missing directory and rejects, rather than repairs, unsafe ones. */
export const prepareManagedRuntimeDirectory = (
  paths: MusicSessionRuntimePaths,
) =>
  Effect.tryPromise({
    try: async () => {
      if (
        dirname(paths.socketPath) !== paths.directory ||
        dirname(paths.markerPath) !== paths.directory
      )
        throw runtimeError(
          "prepare",
          paths.directory,
          "runtime artifacts must be direct children",
        )
      try {
        await (runtimeIo(paths).mkdir ?? mkdir)(paths.directory, {
          mode: 0o700,
        })
      } catch (cause: unknown) {
        if (!(
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "EEXIST"
        ))
          throw cause
      }
      validateDirectory(
        paths,
        await (runtimeIo(paths).lstat ?? lstat)(paths.directory),
      )
    },
    catch: (cause) =>
      cause instanceof MusicSessionRuntimeError
        ? cause
        : runtimeError("prepare", paths.directory, cause),
  })

const missing = async (paths: MusicSessionRuntimePaths, path: string) => {
  try {
    return await (runtimeIo(paths).lstat ?? lstat)(path)
  } catch (cause: unknown) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ENOENT"
    )
      return undefined
    throw cause
  }
}

type ManagedRuntimeInspection = {
  readonly socket: ArtifactProof | undefined
  readonly marker: ArtifactProof | undefined
  readonly deadMarker: boolean
}

const MarkerSafeInt = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
)
const MarkerPositiveInt = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
)
const MarkerSchema = Schema.Struct({
  version: Schema.Literal(1),
  uid: MarkerSafeInt,
  pid: MarkerPositiveInt,
  attemptToken: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
})

/** lstat-only inspection of managed children; malformed/unsafe artifacts fail closed. */
const inspectManagedRuntime = async (
  paths: MusicSessionRuntimePaths,
): Promise<ManagedRuntimeInspection> => {
  await Effect.runPromise(prepareManagedRuntimeDirectory(paths))
  const socketStat = await missing(paths, paths.socketPath)
  if (
    socketStat &&
    (!socketStat.isSocket() ||
      !sameOwner(socketStat, paths.uid) ||
      !hasExactMode(socketStat, 0o600))
  )
    throw runtimeError(
      "inspect",
      paths.socketPath,
      "runtime socket must be a 0600 same-user Unix socket",
    )
  const markerStat = await missing(paths, paths.markerPath)
  if (
    markerStat &&
    (!markerStat.isFile() ||
      !sameOwner(markerStat, paths.uid) ||
      !hasExactMode(markerStat, 0o600))
  )
    throw runtimeError(
      "inspect",
      paths.markerPath,
      "startup marker must be a 0600 regular file owned by this user",
    )
  let deadMarker = false
  if (markerStat) {
    if (markerStat.size > 4096)
      throw runtimeError(
        "inspect",
        paths.markerPath,
        "startup marker is too large",
      )
    let marker: Schema.Schema.Type<typeof MarkerSchema>
    try {
      marker = Schema.decodeUnknownSync(MarkerSchema)(
        JSON.parse(
          await (runtimeIo(paths).readFile ?? readFile)(
            paths.markerPath,
            "utf8",
          ),
        ),
      )
    } catch (cause) {
      throw runtimeError("inspect", paths.markerPath, cause)
    }
    if (marker.uid !== paths.uid)
      throw runtimeError(
        "inspect",
        paths.markerPath,
        "startup marker UID does not match runtime owner",
      )
    try {
      ;(runtimeIo(paths).processExists ?? ((pid) => process.kill(pid, 0)))(
        marker.pid,
      )
    } catch (cause: unknown) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "ESRCH"
      )
        deadMarker = true
    }
  }
  return {
    socket: socketStat
      ? { ...identity(paths.socketPath, socketStat), kind: "socket" }
      : undefined,
    marker: markerStat
      ? { ...identity(paths.markerPath, markerStat), kind: "marker" }
      : undefined,
    deadMarker,
  }
}

const unchanged = async (
  paths: MusicSessionRuntimePaths,
  proof: ArtifactProof,
) => {
  await Effect.runPromise(prepareManagedRuntimeDirectory(paths))
  const stat = await missing(paths, proof.path)
  if (!stat) return false
  const expected = proof.kind === "socket" ? stat.isSocket() : stat.isFile()
  return (
    expected &&
    stat.dev === proof.dev &&
    stat.ino === proof.ino &&
    stat.uid === proof.uid &&
    stat.mode === proof.mode
  )
}

/** Only inspection/probe code can create this guarded cleanup closure. */
const staleCleanup = (
  paths: MusicSessionRuntimePaths,
  proofs: readonly ArtifactProof[],
) => {
  let done = false
  return async () => {
    if (done) return
    for (const proof of proofs) {
      if (!(await unchanged(paths, proof))) {
        const current = await missing(paths, proof.path)
        if (current)
          throw runtimeError(
            "remove",
            proof.path,
            "runtime artifact changed before cleanup",
          )
        continue
      }
      try {
        await (runtimeIo(paths).unlink ?? unlink)(proof.path)
      } catch (cause: unknown) {
        if (!(
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        ))
          throw runtimeError("remove", proof.path, cause)
      }
    }
    done = true
  }
}

const inspectEndpoint = async (paths: MusicSessionRuntimePaths) => {
  await Effect.runPromise(prepareManagedRuntimeDirectory(paths))
  const stat = await missing(paths, paths.socketPath)
  if (
    stat &&
    (!stat.isSocket() ||
      !sameOwner(stat, paths.uid) ||
      !hasExactMode(stat, 0o600))
  )
    throw runtimeError(
      "inspect",
      paths.socketPath,
      "runtime socket must be a 0600 same-user Unix socket",
    )
  return stat
    ? ({
        ...identity(paths.socketPath, stat),
        kind: "socket",
      } satisfies ArtifactProof)
    : undefined
}

export type ManagedRuntimeProbeResult<T> =
  | { readonly type: "healthy"; readonly value: T }
  | { readonly type: "incompatible"; readonly value: T }
  | { readonly type: "missing" }
  | { readonly type: "starting" }
  | { readonly type: "occupied" }
  | { readonly type: "stale"; readonly cleanup: () => Promise<void> }

/**
 * Opaque, file-system-owned state for one discovery pass. Its private fields
 * retain the lstat proof; client code can only ask it to revalidate after the
 * transport result it observed itself.
 */
export class ManagedRuntimeProbe {
  readonly socketPath: string | undefined
  #paths: MusicSessionRuntimePaths
  #socket: ArtifactProof | undefined
  private constructor(
    paths: MusicSessionRuntimePaths,
    socket: ArtifactProof | undefined,
  ) {
    this.#paths = paths
    this.#socket = socket
    this.socketPath = socket?.path
  }
  static async inspect(paths: MusicSessionRuntimePaths) {
    return new ManagedRuntimeProbe(paths, await inspectEndpoint(paths))
  }
  healthy<T>(value: T): ManagedRuntimeProbeResult<T> {
    return { type: "healthy", value }
  }
  incompatible<T>(value: T): ManagedRuntimeProbeResult<T> {
    return { type: "incompatible", value }
  }
  occupied(): ManagedRuntimeProbeResult<never> {
    return { type: "occupied" }
  }
  async absent(): Promise<ManagedRuntimeProbeResult<never>> {
    return this.#markerResult(undefined)
  }
  async refused(): Promise<ManagedRuntimeProbeResult<never>> {
    return this.#markerResult(this.#socket)
  }
  async #markerResult(
    socket: ArtifactProof | undefined,
  ): Promise<ManagedRuntimeProbeResult<never>> {
    const inspected = await inspectManagedRuntime(this.#paths)
    if (
      socket &&
      inspected.socket &&
      (inspected.socket.dev !== socket.dev ||
        inspected.socket.ino !== socket.ino)
    )
      throw runtimeError(
        "probe",
        this.#paths.socketPath,
        "runtime socket changed during discovery",
      )
    if (!socket && inspected.socket) return { type: "occupied" }
    if (inspected.marker && !inspected.deadMarker) return { type: "starting" }
    const proofs = [inspected.socket, inspected.marker].filter(
      (proof): proof is ArtifactProof => proof !== undefined,
    )
    return proofs.length > 0
      ? { type: "stale", cleanup: staleCleanup(this.#paths, proofs) }
      : { type: "missing" }
  }
}

/** Starts one opaque filesystem inspection; client.ts owns connection/hello. */
export const inspectManagedRuntimeForDiscovery = ManagedRuntimeProbe.inspect

/** Compatibility helper for the outer Promise/socket boundary. */
export const resolveConfig = (options: MusicSessionOptions) =>
  Effect.runPromise(resolve(options))
