import * as path from "node:path"
import { Effect, Result } from "effect"
import { globalConfigPath, projectConfigPath } from "../domain/paths.ts"
import {
  buildGlobalConfig,
  detectionNotes,
  pickRoles,
  type Detected,
} from "../domain/setup.ts"
import { ConfigError, type AppError } from "../errors.ts"
import { ok, type ToolResult } from "../result.ts"
import { decodeGlobalConfig } from "../schema/config.ts"
import { FileSystem } from "../services/file-system.ts"

export type SetupParams = {
  /** Write .apnea/config.json role bindings in cwd */
  project?: boolean
  /** Overwrite existing global profiles (default: merge, keep existing profile keys) */
  force?: boolean
  /**
   * Write (or refresh) a loop primer at `<root>/AGENTS.md` for harnesses
   * that read that file but have no Apnea Pi plugin. Merge is marker-guarded
   * — see `AGENTS_SECTION` — so a re-run never clobbers the rest of the file.
   */
  agents_md?: boolean
}

const AGENTS_MD_BEGIN = "<!-- apnea:begin -->"
const AGENTS_MD_END = "<!-- apnea:end -->"

/**
 * Names real `apnea` CLI verbs, never Pi tool names — a harness with no
 * Apnea plugin can only run shell commands, so a primer naming `dispatch_role`
 * would be useless to it.
 */
const AGENTS_SECTION = `${AGENTS_MD_BEGIN}
## Apnea runs

Drive a run with the \`apnea\` CLI. Each result prints \`next:\` — follow it.

\`\`\`
apnea start "<goal>"     # writes state only; does NOT launch a role
apnea dispatch plan      # then follow next: on every result
apnea wait               # exit 3 = still waiting, call again; exit 0 = ready
apnea commit --done      # after an APPROVED code review
\`\`\`

Never edit \`.apnea/state.json\` by hand. \`apnea reset-rounds\` is human-only.
${AGENTS_MD_END}
`

const AGENTS_BLOCK_RE = /<!-- apnea:begin -->[\s\S]*?<!-- apnea:end -->\n?/

/**
 * Replace the marker-bounded block in place when present, otherwise append.
 * Internal to `setupWorkflow`; `setup.test.ts` exercises merge behavior
 * black-box, through the written `AGENTS.md` file, not by importing this.
 */
function mergeAgentsMd(existing: string | null): string {
  if (existing == null || existing.length === 0) return AGENTS_SECTION
  if (AGENTS_BLOCK_RE.test(existing)) {
    return existing.replace(AGENTS_BLOCK_RE, AGENTS_SECTION)
  }
  const sep = existing.endsWith("\n") ? "\n" : "\n\n"
  return `${existing}${sep}${AGENTS_SECTION}`
}

export type SetupDeps = {
  /** Detect an executable on PATH (production: `which`). */
  onPath: (bin: string) => boolean
  /** Prepare host-specific role resources, or return null when none are needed. */
  materializeRoleAgentDir: () => string | null
}

/**
 * Deterministic Apnea setup: detect binaries, write global profiles
 * (and optional project role bindings). Never writes cmd into project config.
 */
export const setupWorkflow = (
  params: SetupParams,
  root: string,
  deps: SetupDeps,
): Effect.Effect<ToolResult, AppError, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem

    const readJsonSafe = (
      filePath: string,
    ): Effect.Effect<Record<string, unknown>> =>
      Effect.gen(function* () {
        const present = yield* fs.exists(filePath)
        if (!present) return {}
        const text = yield* fs.readFile(filePath)
        try {
          const v = JSON.parse(text)
          if (v && typeof v === "object" && !Array.isArray(v)) {
            return v as Record<string, unknown>
          }
          return {}
        } catch {
          return {}
        }
      })

    const has: Detected = {
      pi: deps.onPath("pi"),
      claude: deps.onPath("claude"),
      codex: deps.onPath("codex"),
      herdr: deps.onPath("herdr"),
      jj: deps.onPath("jj"),
      git: deps.onPath("git"),
    }

    if (!has.pi && !has.claude && !has.codex) {
      return yield* new ConfigError({
        message:
          "no supported agent CLI on PATH — install pi, claude, or codex before apnea setup",
      })
    }

    const gPath = globalConfigPath()
    yield* fs.mkdir(path.dirname(gPath), { recursive: true })

    const prev = yield* readJsonSafe(gPath)
    const force = params.force === true
    const globalConfig = buildGlobalConfig({ has, prev, force })

    const serialized = `${JSON.stringify(globalConfig, null, 2)}\n`
    yield* fs.writeFile(gPath, serialized)

    let projectPath: string | null = null
    if (params.project) {
      const pPath = projectConfigPath(root)
      // project: roles only — never cmd
      const projectCfg = { roles: pickRoles(has) }
      yield* fs.writeProjectFile(
        root,
        pPath,
        `${JSON.stringify(projectCfg, null, 2)}\n`,
      )
      projectPath = pPath
    }

    const missing = detectionNotes(has)

    // Host adapters may pre-build launch resources so first dispatch is fast.
    let roleAgentDir: string | null = null
    const materialized = yield* Effect.result(
      Effect.try({ try: deps.materializeRoleAgentDir, catch: (e) => e }),
    )
    if (Result.isSuccess(materialized)) {
      if (materialized.success !== null) {
        roleAgentDir = materialized.success
      }
    } else {
      const e = materialized.failure
      missing.push(
        `role agent dir failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    }

    let agentsMdPath: string | null = null
    if (params.agents_md) {
      const target = path.join(root, "AGENTS.md")
      const present = yield* fs.exists(target)
      const existing = present ? yield* fs.readFile(target) : null
      yield* fs.writeFile(target, mergeAgentsMd(existing))
      agentsMdPath = target
    }

    // A failed decode after writing is a note, not a failure — a user with a
    // malformed pre-existing config must still get a written config and an
    // actionable note, never a hard refusal where today there is none.
    const decoded = decodeGlobalConfig(globalConfig)
    if (Result.isFailure(decoded)) {
      missing.push(
        `global config written but does not validate: ${decoded.failure.message}`,
      )
    }

    const data: Record<string, unknown> = {
      global: gPath,
      project: projectPath,
      detected: has,
      roles: globalConfig.roles,
      notes: missing,
      role_agent_dir: roleAgentDir,
      next: "edit ~/.config/apnea/config.json if model ids differ, then /apnea start <goal> inside Herdr",
    }
    if (params.agents_md) {
      data.agents_md = agentsMdPath
    }
    return ok(`wrote global config ${gPath}`, data)
  })
