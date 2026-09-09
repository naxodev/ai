import { Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import { ConfigError } from "../errors.ts"
import {
  FileSystem,
  PERSISTED_INPUT_MAX_BYTES,
  type FileSystemService,
} from "../services/file-system.ts"

/** In-memory FileSystem for unit tests (paths as exact string keys). */
export function makeFakeFileSystem(
  initial: Record<string, string> = {},
  opts: {
    failWrite?: (path: string) => Error | null
    failRemove?: (path: string) => Error | null
  } = {},
): {
  files: Map<string, string>
  modes: Map<string, number>
  layer: Layer.Layer<FileSystem>
} {
  const files = new Map<string, string>()
  // Track directories created via mkdir (and implied by file writes).
  const dirs = new Set<string>()
  const modes = new Map<string, number>()

  const ensureParent = (p: string) => {
    const i = p.lastIndexOf("/")
    if (i > 0) dirs.add(p.slice(0, i))
  }

  for (const [p, content] of Object.entries(initial)) {
    ensureParent(p)
    files.set(p, content)
  }

  const boundedRead = (
    path: string,
    limit: number,
  ): Effect.Effect<string, ConfigError> => {
    const value = files.get(path)
    if (value === undefined) {
      return Effect.die(new Error(`ENOENT: ${path}`))
    }
    if (Buffer.byteLength(value, "utf8") > limit) {
      return Effect.fail(
        new ConfigError({
          message: `persisted input exceeds ${limit} byte limit: ${path}`,
          path,
        }),
      )
    }
    return Effect.succeed(value)
  }

  const service: FileSystemService = {
    fingerprintProjectFile: (_root, path) =>
      boundedRead(path, 64 * 1024 * 1024).pipe(
        Effect.map((value) => createHash("sha256").update(value).digest("hex")),
      ),
    archiveProjectFile: (_root, source, destination) =>
      Effect.gen(function* () {
        if (files.has(destination))
          return yield* new ConfigError({
            message: "archive collision",
            path: destination,
          })
        const value = files.get(source)
        if (value === undefined)
          return yield* new ConfigError({
            message: "missing archive source",
            path: source,
          })
        const failure = opts.failWrite?.(destination)
        if (failure)
          return yield* new ConfigError({
            message: failure.message,
            path: destination,
          })
        files.set(destination, value)
        files.delete(source)
      }),
    readFile: (path) =>
      Effect.sync(() => {
        const v = files.get(path)
        if (v === undefined) throw new Error(`ENOENT: ${path}`)
        return v
      }),

    writeFile: (path, content) =>
      Effect.sync(() => {
        const failure = opts.failWrite?.(path)
        if (failure) throw failure
        ensureParent(path)
        files.set(path, content)
      }),

    writeProjectFile: (_root, path, content) =>
      Effect.sync(() => {
        const failure = opts.failWrite?.(path)
        if (failure) throw failure
        ensureParent(path)
        files.set(path, content)
      }),

    writeTrustedGlobalFile: (_home, path, content) =>
      Effect.sync(() => {
        const failure = opts.failWrite?.(path)
        if (failure) throw failure
        ensureParent(path)
        files.set(path, content)
      }),

    readTrustedGlobalFile: (_home, path, limit = PERSISTED_INPUT_MAX_BYTES) =>
      boundedRead(path, limit),

    readProjectFile: (_root, path, limit = PERSISTED_INPUT_MAX_BYTES) =>
      boundedRead(path, limit),

    projectPathExists: (_root, path) =>
      Effect.sync(() => files.has(path) || dirs.has(path)),

    mkdirProject: (_root, path) =>
      Effect.sync(() => {
        dirs.add(path)
      }),

    renameProjectFile: (_root, from, to) =>
      Effect.sync(() => {
        const value = files.get(from)
        if (value === undefined) throw new Error(`ENOENT: ${from}`)
        files.delete(from)
        ensureParent(to)
        files.set(to, value)
      }),

    removeProjectFile: (_root, path) =>
      Effect.sync(() => {
        const failure = opts.failRemove?.(path)
        if (failure) throw failure
        files.delete(path)
      }),

    rename: (from, to) =>
      Effect.sync(() => {
        const v = files.get(from)
        if (v === undefined) throw new Error(`ENOENT: ${from}`)
        files.delete(from)
        ensureParent(to)
        files.set(to, v)
      }),

    exists: (path) => Effect.sync(() => files.has(path) || dirs.has(path)),

    mkdir: (path) =>
      Effect.sync(() => {
        dirs.add(path)
      }),

    remove: (path) =>
      Effect.sync(() => {
        const failure = opts.failRemove?.(path)
        if (failure) throw failure
        files.delete(path)
      }),

    copyDir: (from, to) =>
      Effect.sync(() => {
        dirs.add(to)
        const prefix = `${from}/`
        for (const [key, value] of [...files.entries()]) {
          if (key.startsWith(prefix)) {
            const dest = `${to}/${key.slice(prefix.length)}`
            ensureParent(dest)
            files.set(dest, value)
          }
        }
      }),

    chmod: (path, mode) =>
      Effect.sync(() => {
        modes.set(path, mode)
      }),
  }

  return {
    files,
    modes,
    layer: Layer.succeed(FileSystem, FileSystem.of(service)),
  }
}
