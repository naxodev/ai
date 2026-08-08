import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { ConfigError } from "../errors.ts"

export interface FileSystemService {
  readonly readFile: (path: string) => Effect.Effect<string>
  readonly writeFile: (path: string, content: string) => Effect.Effect<void>
  readonly writeProjectFile: (
    root: string,
    destination: string,
    content: string,
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
      Effect.try({
        try: () => {
          const projectRoot = path.resolve(root)
          const target = path.resolve(destination)
          const relative = path.relative(projectRoot, target)
          if (
            relative === "" ||
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          ) {
            throw new ConfigError({
              message: "project file destination must be below project root",
              path: target,
            })
          }

          const components = relative.split(path.sep)
          let current = projectRoot
          for (const component of components.slice(0, -1)) {
            current = path.join(current, component)
            try {
              const stat = fs.lstatSync(current)
              if (stat.isSymbolicLink()) {
                throw new ConfigError({
                  message: `refusing symlink below project root: ${current}`,
                  path: current,
                })
              }
              if (!stat.isDirectory()) {
                throw new ConfigError({
                  message: `project path component is not a directory: ${current}`,
                  path: current,
                })
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error
              fs.mkdirSync(current)
            }
          }

          try {
            if (fs.lstatSync(target).isSymbolicLink()) {
              throw new ConfigError({
                message: `refusing symlink destination: ${target}`,
                path: target,
              })
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
          }

          const temporary = path.join(
            path.dirname(target),
            `.${path.basename(target)}.${randomUUID()}.tmp`,
          )
          let descriptor: number | undefined
          try {
            descriptor = fs.openSync(
              temporary,
              fs.constants.O_WRONLY |
                fs.constants.O_CREAT |
                fs.constants.O_EXCL |
                fs.constants.O_NOFOLLOW,
              0o600,
            )
            fs.writeFileSync(descriptor, content, "utf8")
            fs.fsyncSync(descriptor)
            fs.closeSync(descriptor)
            descriptor = undefined
            fs.renameSync(temporary, target)
          } finally {
            if (descriptor !== undefined) fs.closeSync(descriptor)
            fs.rmSync(temporary, { force: true })
          }
        },
        catch: (e) => e,
      }).pipe(
        Effect.catch((error) =>
          error instanceof ConfigError ? Effect.fail(error) : Effect.die(error),
        ),
      ),

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
