/**
 * Role-pane pi launches must not load pi-vimmode. Modal vim intercepts
 * herdr `pane run` pastes and leaves the pointer sitting in INSERT — the
 * single biggest cause of idle-without-artifact stalls for the coder.
 *
 * Strategy: materialize a dedicated PI_CODING_AGENT_DIR that reuses the
 * user's auth/npm/skills but filters pi-vimmode packages and extensions,
 * then wraps interactive `pi` launches with that env. Reused panes also get a
 * best-effort `/vimmode off` slash command.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

const PI_VIMMODE_MARKERS = ["pi-vimmode", "pekochan069/pi-vimmode"]

export function isPiCmd(cmd: string[] | undefined | null): boolean {
  return piCommandIndex(cmd) !== null
}

function piCommandIndex(cmd: string[] | undefined | null): number | null {
  if (!cmd?.length) return null
  const first = path.basename(cmd[0]!)
  if (first === "pi") return 0
  if (first === "bunx") {
    let index = 1
    while (index < cmd.length) {
      const token = cmd[index]!
      if (
        token === "--bun" ||
        token === "--no-install" ||
        token === "--verbose" ||
        token === "--silent"
      ) {
        index += 1
        continue
      }
      if (token === "-p" || token === "--package") {
        if (cmd[index + 1] === undefined) return null
        index += 2
        continue
      }
      if (token.startsWith("--package=")) {
        if (token.length === "--package=".length) return null
        index += 1
        continue
      }
      if (token === "--") {
        index += 1
        break
      }
      if (token.startsWith("-")) return null
      break
    }
    return path.basename(cmd[index] ?? "") === "pi" ? index : null
  }
  if (first !== "env") return null

  let index = 1
  while (index < cmd.length) {
    const token = cmd[index]!
    if (
      token === "-i" ||
      token === "--ignore-environment" ||
      token === "-v" ||
      token === "--debug"
    ) {
      index += 1
      continue
    }
    if (
      token === "-u" ||
      token === "--unset" ||
      token === "-C" ||
      token === "--chdir" ||
      token === "-P" ||
      token === "-S" ||
      token === "--split-string"
    ) {
      if (cmd[index + 1] === undefined) return null
      index += 2
      continue
    }
    if (token.startsWith("--unset=")) {
      if (token.length === "--unset=".length) return null
      index += 1
      continue
    }
    if (token === "--") {
      index += 1
      break
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1
      continue
    }
    if (token.startsWith("-")) return null
    break
  }
  return path.basename(cmd[index] ?? "") === "pi" ? index : null
}

export function packageSource(entry: unknown): string | null {
  if (typeof entry === "string") return entry
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const src = (entry as Record<string, unknown>).source
    return typeof src === "string" ? src : null
  }
  return null
}

/** True when a packages[] entry is (or wraps) pi-vimmode. */
export function isPiVimModePackage(entry: unknown): boolean {
  const src = packageSource(entry)
  if (!src) return false
  const lower = src.toLowerCase()
  return PI_VIMMODE_MARKERS.some((m) => lower.includes(m))
}

function hasVimModeMarker(value: string): boolean {
  const lower = value.toLowerCase()
  return PI_VIMMODE_MARKERS.some((marker) => lower.includes(marker))
}

/**
 * Drop pi-vimmode from a packages list. Leaves every other entry intact
 * (string form and object form with filters).
 */
export function filterPackagesNoVim(packages: unknown): unknown[] {
  if (!Array.isArray(packages)) return []
  return packages.filter((p) => !isPiVimModePackage(p))
}

const PACKAGE_SOURCE_KEYS = new Set([
  "source",
  "autoload",
  "extensions",
  "skills",
  "prompts",
  "themes",
])
const PACKAGE_RESOURCE_KEYS = [
  "extensions",
  "skills",
  "prompts",
  "themes",
] as const

type ValidPackageSource =
  | string
  | {
      source: string
      autoload?: boolean
      extensions?: string[]
      skills?: string[]
      prompts?: string[]
      themes?: string[]
    }

function validatePackageSource(entry: unknown): ValidPackageSource {
  if (typeof entry === "string") {
    if (entry.trim() === "") throw new Error("package source must not be empty")
    return entry
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("package entry must be a string or object")
  }

  const value = entry as Record<string, unknown>
  if (Object.keys(value).some((key) => !PACKAGE_SOURCE_KEYS.has(key))) {
    throw new Error("package entry contains unknown keys")
  }
  if (typeof value.source !== "string" || value.source.trim() === "") {
    throw new Error("package object source must be a non-empty string")
  }
  if (value.autoload !== undefined && typeof value.autoload !== "boolean") {
    throw new Error("package object autoload must be a boolean")
  }
  for (const key of PACKAGE_RESOURCE_KEYS) {
    const filter = value[key]
    if (
      filter !== undefined &&
      (!Array.isArray(filter) ||
        !filter.every((item) => typeof item === "string"))
    ) {
      throw new Error(`package object ${key} must be an array of strings`)
    }
  }
  return entry as ValidPackageSource
}

function isLocalPackageSource(source: string): boolean {
  const trimmed = source.trim()
  return !["npm:", "git:", "github:", "http:", "https:", "ssh:"].some(
    (prefix) => trimmed.startsWith(prefix),
  )
}

function resolveLocalPath(
  source: string,
  sourceDir: string,
  destDir: string,
): { path: string; resolved: string; isVimMode: boolean } {
  const sourceIsVimMode = hasVimModeMarker(source)
  let expanded = source
  if (source.startsWith("file://")) expanded = fileURLToPath(source)
  else if (source === "~") expanded = os.homedir()
  else if (source.startsWith("~/"))
    expanded = path.join(os.homedir(), source.slice(2))

  const wasRelative = !path.isAbsolute(expanded)
  const resolved = wasRelative
    ? path.resolve(sourceDir, expanded)
    : path.resolve(expanded)
  let canonical = resolved
  try {
    canonical = fs.realpathSync(resolved)
  } catch {
    // Missing local sources retain their resolved path and Pi reports them later.
  }
  const normalized = wasRelative
    ? path.relative(destDir, canonical) || "."
    : canonical
  return {
    path: normalized,
    resolved,
    isVimMode: sourceIsVimMode || hasVimModeMarker(canonical),
  }
}

function normalizeLocalPath(
  source: string,
  sourceDir: string,
  destDir: string,
): string | null {
  const normalized = resolveLocalPath(source, sourceDir, destDir)
  return normalized.isVimMode ? null : normalized.path
}

function normalizePackageSources(
  packages: ValidPackageSource[],
  sourceDir: string,
  destDir: string,
): ValidPackageSource[] {
  return packages.flatMap((entry) => {
    const source = typeof entry === "string" ? entry : entry.source
    if (!isLocalPackageSource(source)) {
      return hasVimModeMarker(source) ? [] : [entry]
    }
    const normalized = normalizeLocalPath(source, sourceDir, destDir)
    if (normalized === null) return []
    return [
      typeof entry === "string" ? normalized : { ...entry, source: normalized },
    ]
  })
}

function normalizeExtensionSources(
  extensions: string[],
  sourceDir: string,
  destDir: string,
): string[] {
  const sourceExtensions = path.resolve(sourceDir, "extensions")
  return extensions.flatMap((extension) => {
    const first = extension[0]
    const operator =
      first === "!" || first === "+" || first === "-" ? first : ""
    const target = operator ? extension.slice(1) : extension
    const normalized = resolveLocalPath(target, sourceDir, destDir)
    if (normalized.isVimMode && operator !== "!" && operator !== "-") return []
    const extensionRelative = path.relative(
      sourceExtensions,
      normalized.resolved,
    )
    const isMirrored =
      extensionRelative === "" ||
      (!extensionRelative.startsWith(`..${path.sep}`) &&
        extensionRelative !== ".." &&
        !path.isAbsolute(extensionRelative))
    const rebased = isMirrored
      ? path.join("extensions", extensionRelative)
      : normalized.path
    return [`${operator}${rebased.split(path.sep).join("/")}`]
  })
}

export function defaultSourceAgentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")
  )
}

export function defaultRoleAgentDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir()
  return path.join(home, ".config", "apnea", "pi-role-agent")
}

function symlinkOrCopy(src: string, dest: string): void {
  if (!fs.existsSync(src)) return
  if (path.resolve(src) === path.resolve(dest)) return
  try {
    if (fs.existsSync(dest) || fs.lstatSync(dest).isSymbolicLink()) {
      fs.rmSync(dest, { recursive: true, force: true })
    }
  } catch {
    try {
      fs.rmSync(dest, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  try {
    fs.symlinkSync(src, dest)
  } catch {
    // Windows or no-symlink FS: copy
    const st = fs.statSync(src)
    if (st.isDirectory()) {
      fs.cpSync(src, dest, { recursive: true, force: true })
    } else {
      fs.copyFileSync(src, dest)
    }
  }
}

/**
 * Build (or refresh) a PI_CODING_AGENT_DIR for Apnea role panes.
 * - settings.json: user's packages/extensions minus pi-vimmode; piVimMode stripped
 * - extensions: safe entries linked individually from the real agent dir
 * - auth/npm/skills/themes/models: linked from the real agent dir
 *
 * Idempotent. Safe to call on every dispatch.
 */
export function materializePiRoleAgentDir(opts?: {
  sourceAgentDir?: string
  destDir?: string
}): string {
  const source = opts?.sourceAgentDir ?? defaultSourceAgentDir()
  const dest = opts?.destDir ?? defaultRoleAgentDir()

  if (safeIsSymlink(dest)) {
    throw new Error("destination Pi agent directory must not be a symlink")
  }
  if (safeIsSymlink(source)) {
    const target = path.resolve(path.dirname(source), fs.readlinkSync(source))
    const expected = path.resolve(dest)
    if (
      process.platform === "win32"
        ? target.toLowerCase() === expected.toLowerCase()
        : target === expected
    ) {
      throw new Error("source and destination Pi agent directories must differ")
    }
  }
  if (path.resolve(source) === path.resolve(dest)) {
    throw new Error("source and destination Pi agent directories must differ")
  }
  if (fs.existsSync(source) && fs.existsSync(dest)) {
    if (fs.realpathSync(source) === fs.realpathSync(dest)) {
      throw new Error("source and destination Pi agent directories must differ")
    }
  }

  fs.mkdirSync(dest, { recursive: true })
  if (
    fs.existsSync(source) &&
    fs.realpathSync(source) === fs.realpathSync(dest)
  ) {
    throw new Error("source and destination Pi agent directories must differ")
  }

  const destSettingsPath = path.join(dest, "settings.json")
  if (safeIsSymlink(destSettingsPath)) {
    throw new Error("destination Pi settings must not be a symlink")
  }

  const srcSettingsPath = path.join(source, "settings.json")
  let settings: Record<string, unknown> = {}
  if (fs.existsSync(srcSettingsPath) || safeIsSymlink(srcSettingsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(srcSettingsPath, "utf8"))
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("settings root must be an object")
      }
      settings = { ...(raw as Record<string, unknown>) }
      if ("packages" in settings && !Array.isArray(settings.packages)) {
        throw new Error("packages must be an array")
      }
      if (Array.isArray(settings.packages)) {
        settings.packages = settings.packages.map(validatePackageSource)
      }
      if (
        "extensions" in settings &&
        (!Array.isArray(settings.extensions) ||
          !settings.extensions.every(
            (extension) =>
              typeof extension === "string" && extension.trim() !== "",
          ))
      ) {
        throw new Error("extensions must be an array of strings")
      }
    } catch (error) {
      throw new Error(
        `invalid source Pi settings at ${srcSettingsPath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  const packages = Array.isArray(settings.packages)
    ? (settings.packages as ValidPackageSource[])
    : []
  const extensions = Array.isArray(settings.extensions)
    ? (settings.extensions as string[])
    : []
  settings.packages = normalizePackageSources(packages, source, dest)
  settings.extensions = normalizeExtensionSources(extensions, source, dest)
  delete settings.piVimMode

  writeSettingsAtomically(
    dest,
    destSettingsPath,
    `${JSON.stringify(settings, null, 2)}\n`,
  )

  const destExtensions = path.join(dest, "extensions")
  materializeExtensionsNoVim(path.join(source, "extensions"), destExtensions)

  // Reuse identity + installed packages; keep sessions local to role dir.
  for (const name of [
    "auth.json",
    "npm",
    "skills",
    "themes",
    "models.json",
    "bin",
    "tools",
  ]) {
    symlinkOrCopy(path.join(source, name), path.join(dest, name))
  }

  // Optional: pi-vimmode.config.js must not apply either
  const vimCfg = path.join(dest, "pi-vimmode.config.js")
  if (fs.existsSync(vimCfg) || safeIsSymlink(vimCfg)) {
    try {
      fs.rmSync(vimCfg, { force: true })
    } catch {
      /* ignore */
    }
  }

  return dest
}

function materializeExtensionsNoVim(sourceDir: string, destDir: string): void {
  fs.rmSync(destDir, { recursive: true, force: true })
  if (!fs.existsSync(sourceDir)) return
  if (extensionPathHasVimModeMarker(sourceDir)) return

  fs.mkdirSync(destDir, { recursive: true })
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourceEntry = path.join(sourceDir, entry.name)
    if (extensionPathHasVimModeMarker(sourceEntry)) continue
    symlinkOrCopy(sourceEntry, path.join(destDir, entry.name))
  }
}

function extensionPathHasVimModeMarker(entryPath: string): boolean {
  if (hasVimModeMarker(entryPath)) return true
  try {
    return hasVimModeMarker(fs.realpathSync(entryPath))
  } catch {
    return true
  }
}

type DirectorySyncIo = Pick<typeof fs, "openSync" | "fsyncSync" | "closeSync">

export function syncDirectoryAfterRename(
  destDir: string,
  platform: NodeJS.Platform = process.platform,
  io: DirectorySyncIo = fs,
): void {
  if (platform === "win32") return
  const directory = io.openSync(destDir, fs.constants.O_RDONLY)
  try {
    io.fsyncSync(directory)
  } finally {
    io.closeSync(directory)
  }
}

function writeSettingsAtomically(
  destDir: string,
  settingsPath: string,
  contents: string,
): void {
  const temporaryPath = path.join(
    destDir,
    `.settings.json.${process.pid}.${randomUUID()}.tmp`,
  )
  let file: number | undefined
  try {
    // Bun 1.3.7 misinterprets Node's numeric O_CREAT flags on Windows.
    // Exclusive creation also refuses an existing symlink at this random leaf.
    file = fs.openSync(temporaryPath, "wx", 0o600)
    fs.writeFileSync(file, contents, "utf8")
    fs.fsyncSync(file)
    fs.closeSync(file)
    file = undefined
    fs.renameSync(temporaryPath, settingsPath)

    syncDirectoryAfterRename(destDir)
  } finally {
    if (file !== undefined) fs.closeSync(file)
    fs.rmSync(temporaryPath, { force: true })
  }
}

function safeIsSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Prefix a pi interactive command with env PI_CODING_AGENT_DIR=... so the
 * role pane never loads pi-vimmode. Non-pi cmds pass through unchanged.
 * `opts` is for tests; production callers omit it.
 */
export function wrapInteractiveCmdNoVim(
  cmd: string[],
  opts?: { sourceAgentDir?: string; destDir?: string },
): string[] {
  const piIndex = piCommandIndex(cmd)
  if (piIndex === null) return cmd
  const agentDir = materializePiRoleAgentDir(opts)
  if (path.basename(cmd[0]!) === "env") {
    return [
      "env",
      ...cmd.slice(1, piIndex),
      `PI_CODING_AGENT_DIR=${agentDir}`,
      ...cmd.slice(piIndex),
    ]
  }
  return ["env", `PI_CODING_AGENT_DIR=${agentDir}`, ...cmd]
}
