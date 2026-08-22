import * as path from "node:path"
import { Clock, Context, Effect, Layer, Result } from "effect"
import {
  apneaRoot,
  artifactsDir,
  statePath,
  tasksDir,
} from "../domain/paths.ts"
import { ConfigError, NoRunState, StateCorrupt } from "../errors.ts"
import type { RunState } from "../domain/types.ts"
import { decodeRunState } from "../schema/state.ts"
import { FileSystem, type FileSystemService } from "./file-system.ts"

export interface RunStoreService {
  readonly load: (
    root: string,
  ) => Effect.Effect<RunState | null, StateCorrupt | ConfigError>
  readonly save: (
    state: RunState,
    root: string,
  ) => Effect.Effect<void, ConfigError>
  readonly require: (
    root: string,
  ) => Effect.Effect<RunState, NoRunState | StateCorrupt | ConfigError>
  readonly abandon: (
    root: string,
  ) => Effect.Effect<string, NoRunState | ConfigError>
}

export class RunStore extends Context.Service<RunStore, RunStoreService>()(
  "apnea/RunStore",
) {}

function ensureApneaDirs(
  fs: FileSystemService,
  root: string,
): Effect.Effect<void, ConfigError> {
  const dirs = [
    apneaRoot(root),
    artifactsDir(root),
    tasksDir(root),
    path.join(artifactsDir(root), "plan-review"),
  ]
  return Effect.forEach(dirs, (d) => fs.mkdirProject(root, d), {
    discard: true,
  })
}

export const RunStoreLive = Layer.effect(
  RunStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem

    const load = (
      root: string,
    ): Effect.Effect<RunState | null, StateCorrupt | ConfigError> =>
      Effect.gen(function* () {
        const p = statePath(root)
        const present = yield* fs.projectPathExists(root, p)
        if (!present) return null
        const text = yield* fs.readProjectFile(root, p)
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch (e) {
          return yield* new StateCorrupt({
            path: p,
            message: e instanceof Error ? e.message : String(e),
          })
        }
        const decoded = decodeRunState(json, p)
        if (Result.isFailure(decoded)) {
          return yield* decoded.failure
        }
        return decoded.success
      })

    const save = (
      state: RunState,
      root: string,
    ): Effect.Effect<void, ConfigError> =>
      Effect.gen(function* () {
        yield* ensureApneaDirs(fs, root)
        const p = statePath(root)
        const body = `${JSON.stringify(state, null, 2)}\n`
        yield* fs.writeProjectFile(root, p, body)
      })

    const require = (
      root: string,
    ): Effect.Effect<RunState, NoRunState | StateCorrupt | ConfigError> =>
      Effect.gen(function* () {
        const s = yield* load(root)
        if (!s) return yield* new NoRunState({})
        return s
      })

    const abandon = (
      root: string,
    ): Effect.Effect<string, NoRunState | ConfigError> =>
      Effect.gen(function* () {
        const p = statePath(root)
        const present = yield* fs.projectPathExists(root, p)
        if (!present) return yield* new NoRunState({})
        const millis = yield* Clock.currentTimeMillis
        const bak = `${p}.abandoned.${millis}`
        yield* fs.renameProjectFile(root, p, bak)
        return bak
      })

    return RunStore.of({ load, save, require, abandon })
  }),
)
