import { Effect, Layer } from "effect"
import { FileSystem, type FileSystemService } from "../services/file-system.ts"

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

  const service: FileSystemService = {
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

    readProjectFile: (_root, path) =>
      Effect.sync(() => {
        const value = files.get(path)
        if (value === undefined) throw new Error(`ENOENT: ${path}`)
        return value
      }),

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
