import * as path from "node:path"
import * as os from "node:os"
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
import { decodeGlobalConfig, decodeProjectConfig } from "../schema/config.ts"
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
  /** Trusted account home. Production uses node:os.homedir(). */
  trustedHome?: () => string
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

    const trustedHome = deps.trustedHome?.() ?? os.homedir()
    const gPath = globalConfigPath(trustedHome)

    const force = params.force === true
    let replacedMalformedGlobal = false
    let prev: Record<string, unknown> = {}
    if (yield* fs.exists(gPath)) {
      const text = yield* fs.readTrustedGlobalFile(trustedHome, gPath)
      try {
        const parsed: unknown = JSON.parse(text)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("global config must be a JSON object")
        }
        prev = parsed as Record<string, unknown>
      } catch (error) {
        if (!force) {
          return yield* new ConfigError({
            message: `existing global config is malformed; refusing to replace it without --force: ${error instanceof Error ? error.message : String(error)}`,
            path: gPath,
          })
        }
        replacedMalformedGlobal = true
      }
    }
    const globalConfig = buildGlobalConfig({ has, prev, force })

    const serialized = `${JSON.stringify(globalConfig, null, 2)}\n`

    let projectPath: string | null = null
    if (params.project) {
      const pPath = projectConfigPath(root)
      if (yield* fs.projectPathExists(root, pPath)) {
        const text = yield* fs.readProjectFile(root, pPath)
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch (error) {
          return yield* new ConfigError({
            message: `invalid JSON at ${pPath}: ${error instanceof Error ? error.message : String(error)}`,
            path: pPath,
          })
        }
        const decoded = decodeProjectConfig(parsed)
        if (Result.isFailure(decoded)) return yield* decoded.failure
      }
      projectPath = pPath
    }

    yield* fs.writeTrustedGlobalFile(trustedHome, gPath, serialized)

    if (projectPath) {
      // project: roles only — never cmd
      const projectCfg = { roles: pickRoles(has) }
      yield* fs.writeProjectFile(
        root,
        projectPath,
        `${JSON.stringify(projectCfg, null, 2)}\n`,
      )
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
      const present = yield* fs.projectPathExists(root, target)
      const existing = present ? yield* fs.readProjectFile(root, target) : null
      yield* fs.writeProjectFile(root, target, mergeAgentsMd(existing))
      agentsMdPath = target
    }

    // Generated defaults can still inherit malformed profile or role shapes
    // from valid JSON. Report those separately from JSON parse refusals.
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
    if (replacedMalformedGlobal) data.replaced_malformed_global = true
    return ok(
      replacedMalformedGlobal
        ? `replaced malformed global config ${gPath}`
        : `wrote global config ${gPath}`,
      data,
    )
  })
