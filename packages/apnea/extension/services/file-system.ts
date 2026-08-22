import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { ConfigError } from "../errors.ts"

export const PERSISTED_INPUT_MAX_BYTES = 1024 * 1024

export interface FileSystemService {
  readonly readFile: (path: string) => Effect.Effect<string>
  readonly writeFile: (path: string, content: string) => Effect.Effect<void>
  readonly writeProjectFile: (
    root: string,
    destination: string,
    content: string,
  ) => Effect.Effect<void, ConfigError>
  readonly writeTrustedGlobalFile: (
    accountHome: string,
    destination: string,
    content: string,
  ) => Effect.Effect<void, ConfigError>
  readonly readTrustedGlobalFile: (
    accountHome: string,
    source: string,
    limit?: number,
  ) => Effect.Effect<string, ConfigError>
  readonly readProjectFile: (
    root: string,
    source: string,
    limit?: number,
  ) => Effect.Effect<string, ConfigError>
  readonly projectPathExists: (
    root: string,
    destination: string,
  ) => Effect.Effect<boolean, ConfigError>
  readonly mkdirProject: (
    root: string,
    destination: string,
  ) => Effect.Effect<void, ConfigError>
  readonly renameProjectFile: (
    root: string,
    from: string,
    to: string,
  ) => Effect.Effect<void, ConfigError>
  readonly removeProjectFile: (
    root: string,
    destination: string,
  ) => Effect.Effect<void, ConfigError>
  readonly rename: (from: string, to: string) => Effect.Effect<void>
  readonly exists: (path: string) => Effect.Effect<boolean>
  readonly mkdir: (
    path: string,
    opts?: { recursive?: boolean },
  ) => Effect.Effect<void>
  readonly remove: (path: string) => Effect.Effect<void>
  readonly copyDir: (from: string, to: string) => Effect.Effect<void>
  readonly chmod: (path: string, mode: number) => Effect.Effect<void>
}

/**
 * Thin FS service. Unexpected IO failures are defects (orDie) — no FsError tag.
 */
export class FileSystem extends Context.Service<
  FileSystem,
  FileSystemService
>()("apnea/FileSystem") {}

function secureProjectPath(root: string, destination: string): string {
  const lexicalRoot = path.resolve(root)
  const lexicalTarget = path.resolve(destination)
  const relative = path.relative(lexicalRoot, lexicalTarget)
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new ConfigError({
      message: "project file destination must be below project root",
      path: lexicalTarget,
    })
  }

  const projectRoot = fs.realpathSync(lexicalRoot)
  const target = path.join(projectRoot, relative)
  let current = projectRoot
  const components = relative.split(path.sep)
  for (const [index, component] of components.entries()) {
    current = path.join(current, component)
    try {
      const stat = fs.lstatSync(current)
      if (stat.isSymbolicLink()) {
        throw new ConfigError({
          message: `refusing symlink below project root: ${current}`,
          path: current,
        })
      }
      if (index < components.length - 1 && !stat.isDirectory()) {
        throw new ConfigError({
          message: `project path component is not a safe directory: ${current}`,
          path: current,
        })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return target
}

function createProjectDirectories(root: string, destination: string): void {
  const target = secureProjectPath(root, destination)
  const projectRoot = fs.realpathSync(path.resolve(root))
  const relative = path.relative(projectRoot, target)
  let current = projectRoot
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component)
    try {
      const stat = fs.lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ConfigError({
          message: `project path component is not a safe directory: ${current}`,
          path: current,
        })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      fs.mkdirSync(current, { mode: 0o700 })
    }
  }
}

function trustedGlobalPath(accountHome: string, destination: string): string {
  const lexicalHome = path.resolve(accountHome)
  const lexicalTarget = path.resolve(destination)
  const relative = path.relative(lexicalHome, lexicalTarget)
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new ConfigError({
      message: "trusted global file destination must be below account home",
      path: lexicalTarget,
    })
  }

  const home = fs.realpathSync(lexicalHome)
  const target = path.join(home, relative)
  let current = home
  const components = relative.split(path.sep)
  for (const [index, component] of components.entries()) {
    current = path.join(current, component)
    try {
      const stat = fs.lstatSync(current)
      if (stat.isSymbolicLink()) {
        throw new ConfigError({
          message: `refusing symlink below trusted account home: ${current}`,
          path: current,
        })
      }
      if (index < components.length - 1 && !stat.isDirectory()) {
        throw new ConfigError({
          message: `trusted global path component is not a safe directory: ${current}`,
          path: current,
        })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return target
}

function createTrustedGlobalDirectories(
  accountHome: string,
  destination: string,
): void {
  const target = trustedGlobalPath(accountHome, destination)
  const home = fs.realpathSync(path.resolve(accountHome))
  const relative = path.relative(home, target)
  let current = home
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component)
    try {
      const stat = fs.lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ConfigError({
          message: `trusted global path component is not a safe directory: ${current}`,
          path: current,
        })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      fs.mkdirSync(current)
    }
  }
}

function projectEffect<A>(operation: () => A): Effect.Effect<A, ConfigError> {
  return Effect.try({ try: operation, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      error instanceof ConfigError ? Effect.fail(error) : Effect.die(error),
    ),
  )
}

function readRegularUtf8(target: string, limit: number): string {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > PERSISTED_INPUT_MAX_BYTES
  ) {
    throw new ConfigError({
      message: `persisted input byte limit must be between 0 and ${PERSISTED_INPUT_MAX_BYTES}`,
      path: target,
    })
  }
  let descriptor: number | undefined
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0
    const nonBlocking = fs.constants.O_NONBLOCK ?? 0
    descriptor = fs.openSync(
      target,
      fs.constants.O_RDONLY | noFollow | nonBlocking,
    )
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new ConfigError({
        message: `persisted input is not a regular file: ${target}`,
        path: target,
      })
    }

    const bytes = Buffer.allocUnsafe(limit + 1)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        null,
      )
      if (count === 0) break
      offset += count
    }
    if (offset > limit) {
      throw new ConfigError({
        message: `persisted input exceeds ${limit} byte limit: ${target}`,
        path: target,
        details: { limit_bytes: limit },
      })
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, offset),
      )
    } catch {
      throw new ConfigError({
        message: `persisted input is not valid UTF-8: ${target}`,
        path: target,
      })
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function fsyncParentDirectory(target: string): void {
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(path.dirname(target), fs.constants.O_RDONLY)
    fs.fsyncSync(descriptor)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // POSIX permits EINVAL/ENOTSUP for unsupported directory fsync. Windows
    // additionally rejects directory descriptors with EISDIR/EPERM.
    const unsupported =
      ["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(code ?? "") ||
      (process.platform === "win32" && ["EISDIR", "EPERM"].includes(code ?? ""))
    if (!unsupported) {
      throw error
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

export const FileSystemLive = Layer.succeed(
  FileSystem,
  FileSystem.of({
    readFile: (path) =>
      Effect.try({
        try: () => fs.readFileSync(path, "utf8"),
        catch: (e) => e,
      }).pipe(Effect.orDie),

    writeFile: (path, content) =>
      Effect.try({
        try: () => {
          fs.writeFileSync(path, content, "utf8")
        },
        catch: (e) => e,
      }).pipe(Effect.orDie),

    writeProjectFile: (root, destination, content) =>
      projectEffect(() => {
        const target = secureProjectPath(root, destination)
        if (path.resolve(path.dirname(destination)) !== path.resolve(root)) {
          createProjectDirectories(root, path.dirname(destination))
        }

        const temporary = path.join(
          path.dirname(target),
          `.${path.basename(target)}.${randomUUID()}.tmp`,
        )
        let descriptor: number | undefined
        try {
          descriptor = fs.openSync(temporary, "wx", 0o600)
          fs.writeFileSync(descriptor, content, "utf8")
          fs.fsyncSync(descriptor)
          fs.closeSync(descriptor)
          descriptor = undefined
          fs.renameSync(temporary, target)
          fsyncParentDirectory(target)
        } finally {
          if (descriptor !== undefined) fs.closeSync(descriptor)
          fs.rmSync(temporary, { force: true })
        }
      }),

    writeTrustedGlobalFile: (accountHome, destination, content) =>
      projectEffect(() => {
        const target = trustedGlobalPath(accountHome, destination)
        createTrustedGlobalDirectories(accountHome, path.dirname(destination))

        let mode = 0o666
        let preserveMode = false
        try {
          const existing = fs.lstatSync(target)
          if (existing.isSymbolicLink() || !existing.isFile()) {
            throw new ConfigError({
              message: `trusted global destination is not a safe regular file: ${target}`,
              path: target,
            })
          }
          mode = existing.mode & 0o777
          preserveMode = true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }

        const temporary = path.join(
          path.dirname(target),
          `.${path.basename(target)}.${randomUUID()}.tmp`,
        )
        let descriptor: number | undefined
        try {
          descriptor = fs.openSync(temporary, "wx", mode)
          if (preserveMode) fs.fchmodSync(descriptor, mode)
          fs.writeFileSync(descriptor, content, "utf8")
          fs.fsyncSync(descriptor)
          fs.closeSync(descriptor)
          descriptor = undefined
          fs.renameSync(temporary, target)
          fsyncParentDirectory(target)
        } finally {
          if (descriptor !== undefined) fs.closeSync(descriptor)
          fs.rmSync(temporary, { force: true })
        }
      }),

    readTrustedGlobalFile: (
      accountHome,
      source,
      limit = PERSISTED_INPUT_MAX_BYTES,
    ) =>
      projectEffect(() =>
        readRegularUtf8(trustedGlobalPath(accountHome, source), limit),
      ),

    readProjectFile: (root, source, limit = PERSISTED_INPUT_MAX_BYTES) =>
      projectEffect(() =>
        readRegularUtf8(secureProjectPath(root, source), limit),
      ),

    projectPathExists: (root, destination) =>
      projectEffect(() => fs.existsSync(secureProjectPath(root, destination))),

    mkdirProject: (root, destination) =>
      projectEffect(() => createProjectDirectories(root, destination)),

    renameProjectFile: (root, from, to) =>
      projectEffect(() => {
        const source = secureProjectPath(root, from)
        const destination = secureProjectPath(root, to)
        createProjectDirectories(root, path.dirname(to))
        fs.renameSync(source, destination)
      }),

    removeProjectFile: (root, destination) =>
      projectEffect(() => {
        fs.rmSync(secureProjectPath(root, destination), { force: true })
      }),

    rename: (from, to) =>
      Effect.try({
        try: () => {
          fs.renameSync(from, to)
        },
        catch: (e) => e,
      }).pipe(Effect.orDie),

    exists: (path) => Effect.sync(() => fs.existsSync(path)),

    mkdir: (path, opts) =>
      Effect.try({
        try: () => {
          fs.mkdirSync(path, { recursive: opts?.recursive ?? true })
        },
        catch: (e) => e,
      }).pipe(Effect.orDie),

    remove: (path) =>
      Effect.try({
        try: () => {
          fs.rmSync(path, { force: true })
        },
        catch: (e) => e,
      }).pipe(Effect.orDie),

    copyDir: (from, to) =>
      Effect.try({
        try: () => {
          fs.cpSync(from, to, { recursive: true, force: true })
        },
        catch: (e) => e,
      }).pipe(Effect.orDie),

    chmod: (path, mode) =>
      Effect.try({
        try: () => {
          fs.chmodSync(path, mode)
        },
        catch: (e) => e,
      }).pipe(Effect.orDie),
  }),
)
