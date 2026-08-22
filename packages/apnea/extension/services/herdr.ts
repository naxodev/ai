import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { Clock, Context, Effect, Layer, Option, Result } from "effect"
import { shellJoin } from "../domain/herdr.ts"
import { HerdrError } from "../errors.ts"
import type { ApneaHostAdapter } from "../host-adapter.ts"
import { neutralHostAdapter } from "../host-adapter.ts"

export type PaneInfo = {
  ok: boolean
  /** True only when Herdr explicitly reports that this pane does not exist. */
  missing?: boolean
  agent_status?: string
  label?: string
  agent?: string
}
export type RolePaneRef = { pane_id: string; label: string }
export type HerdrAvailability = "available" | "unavailable"
export type InteractiveLaunch = {
  pane_id: string
  label: string
  reused: boolean
  prompt_accepted: boolean
  prompt_attempts: number
  last_status?: string
}

export interface HerdrService {
  readonly enabled: Effect.Effect<boolean>
  /** Dispatch preflight that distinguishes a stale pane from CLI failures. */
  readonly availability: Effect.Effect<HerdrAvailability, HerdrError>
  readonly paneGet: (paneId: string) => Effect.Effect<PaneInfo>
  readonly paneRun: (
    paneId: string,
    command: string,
  ) => Effect.Effect<void, HerdrError>
  readonly paneReadRecent: (
    paneId: string,
  ) => Effect.Effect<string | null, HerdrError>
  readonly paneForegroundNames: (paneId: string) => Effect.Effect<string[]>
  readonly runInteractivePrompt: (
    role: string,
    interactiveCmd: string[],
    prompt: string,
    prefer: RolePaneRef | null,
  ) => Effect.Effect<InteractiveLaunch, HerdrError>
}

export class Herdr extends Context.Service<Herdr, HerdrService>()(
  "apnea/Herdr",
) {}

export const paneReadRecentArgs = (paneId: string): string[] => [
  "pane",
  "read",
  paneId,
  "--source",
  "recent-unwrapped",
  "--lines",
  "80",
  "--format",
  "text",
]

function herdrCli(args: string[]): { ok: boolean; json: unknown; raw: string } {
  const r = spawnSync("herdr", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })
  const raw = `${r.stdout ?? ""}${r.stderr ?? ""}`
  if (r.status !== 0) {
    return { ok: false, json: null, raw }
  }
  // herdr often prints one JSON object
  const line = (r.stdout ?? "").trim().split(/\n/).filter(Boolean).pop() ?? ""
  try {
    return { ok: true, json: JSON.parse(line), raw }
  } catch {
    return { ok: true, json: null, raw }
  }
}

function resultOf(json: unknown): Record<string, unknown> | null {
  if (!json || typeof json !== "object") return null
  const o = json as Record<string, unknown>
  if (o.result && typeof o.result === "object")
    return o.result as Record<string, unknown>
  return o
}

function isExecutableFile(abs: string): boolean {
  try {
    fs.accessSync(abs, fs.constants.X_OK)
    return fs.statSync(abs).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve a binary against the current environment. Walks PATH directly so
 * setup detection does not depend on a separate `which` executable.
 */
export function resolveExecutable(
  bin: string,
  envPath: string | undefined = process.env.PATH,
): string | null {
  if (!bin) return null
  if (bin.includes("/") || bin.includes("\\")) {
    const abs = path.isAbsolute(bin) ? bin : path.resolve(bin)
    return isExecutableFile(abs) ? abs : null
  }
  for (const dir of (envPath ?? "").split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, bin)
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

function herdrEnabledSync(): boolean {
  return process.env.HERDR_ENV === "1"
}

export function probeHerdrAvailability(
  env: { HERDR_ENV?: string; HERDR_PANE_ID?: string },
  paneGet: (paneId: string) => { ok: boolean; raw: string },
): HerdrAvailability {
  if (env.HERDR_ENV !== "1") return "unavailable"
  const current = env.HERDR_PANE_ID
  if (!current) return "unavailable"
  const r = paneGet(current)
  if (r.ok) return "available"
  if (/pane_not_found|pane not found/i.test(r.raw)) return "unavailable"
  throw new HerdrError({
    message: `failed to verify current Herdr pane ${current}: ${r.raw.trim() || "unknown herdr error"}`,
    command: "herdr pane get",
  })
}

function herdrAvailabilitySync(): HerdrAvailability {
  return probeHerdrAvailability(
    {
      HERDR_ENV: process.env.HERDR_ENV,
      HERDR_PANE_ID: process.env.HERDR_PANE_ID,
    },
    (paneId) => herdrCli(["pane", "get", paneId]),
  )
}

function paneGetSync(paneId: string): PaneInfo {
  const r = herdrCli(["pane", "get", paneId])
  if (!r.ok) {
    return {
      ok: false,
      missing: /pane_not_found|pane not found/i.test(r.raw),
    }
  }
  const res = resultOf(r.json)
  const pane = (res?.pane as Record<string, unknown>) ?? {}
  return {
    ok: true,
    agent_status: pane.agent_status ? String(pane.agent_status) : undefined,
    label: pane.label ? String(pane.label) : undefined,
    agent: pane.agent ? String(pane.agent) : undefined,
  }
}

function paneAliveSync(paneId: string): boolean {
  return paneGetSync(paneId).ok
}

function paneReadRecentSync(paneId: string): string {
  const args = paneReadRecentArgs(paneId)
  const r = spawnSync("herdr", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })
  if (r.status !== 0 || r.error) {
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error?.message ?? ""}`
      .trim()
      .split(/\r?\n/)
      .slice(-80)
      .join("\n")
    throw new HerdrError({
      message: `herdr pane read failed for ${paneId}${output ? `: ${output}` : ""}`,
      command: shellJoin(["herdr", ...args]),
      ...(output ? { details: { output } } : {}),
    })
  }
  return r.stdout ?? ""
}

/** Prefer right on wide panes, down on tall/narrow ones. */
function splitDirectionSync(): "right" | "down" {
  const current = process.env.HERDR_PANE_ID
  if (!current) return "right"
  const r = herdrCli(["pane", "layout", "--pane", current])
  const res = resultOf(r.json)
  const layout = res?.layout as Record<string, unknown> | undefined
  const panes = (layout?.panes as Array<Record<string, unknown>>) ?? []
  const me = panes.find((p) => String(p.pane_id) === current)
  const rect = me?.rect as { width?: number; height?: number } | undefined
  if (rect?.width != null && rect?.height != null) {
    return rect.width >= rect.height ? "right" : "down"
  }
  return "right"
}

function splitPaneSync(): string {
  const direction = splitDirectionSync()
  const r = herdrCli([
    "pane",
    "split",
    "--current",
    "--direction",
    direction,
    "--no-focus",
  ])
  if (!r.ok)
    throw new HerdrError({ message: `herdr pane split failed: ${r.raw}` })
  const res = resultOf(r.json)
  const pane = res?.pane as Record<string, unknown> | undefined
  const id = pane?.pane_id ? String(pane.pane_id) : null
  if (!id) {
    throw new HerdrError({
      message: `herdr pane split: no pane_id in ${r.raw}`,
    })
  }
  return id
}

function renamePaneSync(paneId: string, label: string): void {
  const r = herdrCli(["pane", "rename", paneId, label])
  if (!r.ok) {
    throw new HerdrError({ message: `herdr pane rename failed: ${r.raw}` })
  }
}

/**
 * Send text + Enter into a pane.
 * When a live agent TUI is focused, this submits a prompt (not a shell command).
 * When the pane is a bare shell, this runs a shell line.
 */
function paneRunSync(paneId: string, command: string): void {
  const r = herdrCli(["pane", "run", paneId, command])
  if (!r.ok) {
    throw new HerdrError({
      message: `herdr pane run failed: ${r.raw}`,
      command: "herdr pane run",
    })
  }
}

/** Send raw key names (e.g. Escape, Enter) into a pane. */
function paneSendKeysSync(paneId: string, keys: string[]): void {
  if (keys.length === 0) return
  const r = herdrCli(["pane", "send-keys", paneId, ...keys])
  if (!r.ok) {
    throw new HerdrError({ message: `herdr pane send-keys failed: ${r.raw}` })
  }
}

function paneForegroundNamesSync(paneId: string): string[] {
  try {
    const r = spawnSync("herdr", ["pane", "process-info", "--pane", paneId], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    })
    if (r.status !== 0) return []
    const line = (r.stdout ?? "").trim().split(/\n/).filter(Boolean).pop() ?? ""
    const json = JSON.parse(line) as {
      result?: {
        process_info?: {
          foreground_processes?: Array<{
            name?: string
            argv0?: string
            cmdline?: string
          }>
        }
      }
    }
    const procs = json.result?.process_info?.foreground_processes ?? []
    return procs.map((p) => p.cmdline || p.argv0 || p.name || "?")
  } catch {
    return []
  }
}

function toHerdrError(e: unknown): HerdrError {
  return e instanceof HerdrError
    ? e
    : new HerdrError({ message: e instanceof Error ? e.message : String(e) })
}

/**
 * Effect wrappers for the throwing `*Sync` helpers. A `throw` inside
 * `Effect.gen` is a defect, and defects pass straight through `Effect.ignore` /
 * `Effect.option` — so every sync herdr call must go through `Effect.try` for
 * best-effort recovery blocks to actually be best-effort.
 */
function paneRun(
  paneId: string,
  command: string,
): Effect.Effect<void, HerdrError> {
  return Effect.try({
    try: () => paneRunSync(paneId, command),
    catch: toHerdrError,
  })
}

function paneClose(paneId: string): Effect.Effect<void, HerdrError> {
  return Effect.try({
    try: () => {
      const r = herdrCli(["pane", "close", paneId])
      if (!r.ok) {
        throw new HerdrError({
          message: `herdr pane close failed: ${r.raw}`,
          command: "herdr pane close",
        })
      }
    },
    catch: toHerdrError,
  })
}

function withLaunchDetails(
  error: HerdrError,
  details: Record<string, unknown>,
): HerdrError {
  return new HerdrError({
    message: error.message,
    ...(error.command !== undefined ? { command: error.command } : {}),
    details: { ...(error.details ?? {}), ...details },
  })
}

/** Close a pane that cannot have received the task prompt without hiding the launch error. */
export function cleanupFailedInteractiveLaunch(
  error: HerdrError,
  paneId: string,
  close: (paneId: string) => Effect.Effect<void, HerdrError> = paneClose,
): Effect.Effect<never, HerdrError> {
  return Effect.gen(function* () {
    const cleanup = yield* Effect.result(close(paneId))
    return yield* withLaunchDetails(error, {
      delivery: "not_delivered",
      pane_id: paneId,
      newly_created: true,
      pane_cleanup: Result.isSuccess(cleanup) ? "closed" : "failed",
      ...(Result.isFailure(cleanup)
        ? { pane_cleanup_error: cleanup.failure.message }
        : {}),
    })
  })
}

function sendKeys(
  paneId: string,
  keys: string[],
): Effect.Effect<void, HerdrError> {
  return Effect.try({
    try: () => paneSendKeysSync(paneId, keys),
    catch: toHerdrError,
  })
}

/** Unique label for a role slot (stable for the run when we reuse the pane). */
function roleLabel(role: string, millis: number): string {
  const id = `${millis.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  return `apnea:${role}:${id}`
}

/**
 * Wait until agent reports idle or done (ready for a prompt).
 * Uses herdr wait when available; falls back to poll.
 */
function waitAgentReady(
  paneId: string,
  timeoutMs = 90_000,
): Effect.Effect<string | undefined> {
  return Effect.gen(function* () {
    // Prefer Herdr's blocking wait (does not freeze our caller if we use it
    // only for short readiness; dispatch is already a tool call).
    const r = herdrCli([
      "wait",
      "agent-status",
      paneId,
      "--status",
      "idle",
      "--timeout",
      String(timeoutMs),
    ])
    if (r.ok) {
      const s = paneGetSync(paneId).agent_status
      if (s === "idle" || s === "done") return s
    }
    // fall back: poll (done also counts as ready). Clock, not Date.now(): the
    // sleep below is virtualized under TestClock, so a wall-clock deadline
    // would never be reached in a test.
    const deadline =
      (yield* Clock.currentTimeMillis) + Math.min(timeoutMs, 30_000)
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const s = paneGetSync(paneId).agent_status
      if (s === "idle" || s === "done") return s
      yield* Effect.sleep(500)
    }
    return paneGetSync(paneId).agent_status
  })
}

/**
 * The three pane operations the recovery ladder drives.
 *
 * Injectable because the ladder cannot otherwise be tested: Bun's `spawnSync`
 * resolves binaries against the process's real PATH and ignores mutations to
 * `process.env.PATH`, so a fake `herdr` placed on a temp PATH is never invoked.
 */
export type PromptProbes = {
  readonly status: () => string | undefined
  readonly sendKeys: (keys: string[]) => Effect.Effect<void, HerdrError>
  readonly run: (text: string) => Effect.Effect<void, HerdrError>
}

function livePromptProbes(paneId: string): PromptProbes {
  return {
    status: () => paneGetSync(paneId).agent_status,
    sendKeys: (keys) => sendKeys(paneId, keys),
    run: (text) => paneRun(paneId, text),
  }
}

/**
 * After submitting a prompt, confirm the agent actually started working.
 * Claude often parks multi-line paste in the input without submitting;
 * pi+vim can leave the prompt in INSERT mode. Recover with Escape+Enter
 * (then one full re-submit) before giving up.
 */
export function ensurePromptSubmitted(
  paneId: string,
  prompt: string,
  opts?: {
    settleMs?: number
    workingWaitMs?: number
    probes?: PromptProbes
  },
): Effect.Effect<{
  accepted: boolean
  attempts: number
  last_status?: string
}> {
  return Effect.gen(function* () {
    const probes = opts?.probes ?? livePromptProbes(paneId)
    const settleMs = opts?.settleMs ?? 2500
    const workingWaitMs = opts?.workingWaitMs ?? 12_000
    let attempts = 1

    const waitForWorking = (ms: number): Effect.Effect<string | undefined> =>
      Effect.gen(function* () {
        const deadline = (yield* Clock.currentTimeMillis) + ms
        while ((yield* Clock.currentTimeMillis) < deadline) {
          const s = probes.status()
          if (s === "working" || s === "blocked") return s
          yield* Effect.sleep(400)
        }
        return probes.status()
      })

    // Give the first paneRun a moment to flip status.
    yield* Effect.sleep(settleMs)
    let status = yield* waitForWorking(workingWaitMs)
    if (status === "working" || status === "blocked") {
      return { accepted: true, attempts, last_status: status }
    }

    // Paste often lands without submit — Enter alone recovers Claude;
    // Escape first exits pi-vim INSERT so Enter can actually submit.
    // `*Sync` helpers throw, and a throw inside Effect.gen is a *defect* that
    // Effect.ignore/Effect.option do not catch — wrap in Effect.try so a dead
    // pane stays best-effort instead of aborting dispatch before state is saved.
    attempts += 1
    yield* Effect.ignore(
      Effect.gen(function* () {
        yield* probes.sendKeys(["Escape"])
        yield* Effect.sleep(150)
        yield* probes.sendKeys(["Enter"])
      }),
    )
    status = yield* waitForWorking(workingWaitMs)
    if (status === "working" || status === "blocked") {
      return { accepted: true, attempts, last_status: status }
    }

    // Full re-submit once (covers lost/mangled first paste).
    attempts += 1
    const resubmitted = yield* Effect.option(
      Effect.gen(function* () {
        yield* probes.sendKeys(["Escape"])
        yield* Effect.sleep(100)
        yield* probes.run(prompt)
      }),
    )
    if (Option.isNone(resubmitted)) {
      return {
        accepted: false,
        attempts,
        last_status: probes.status(),
      }
    }
    yield* Effect.sleep(settleMs)
    status = yield* waitForWorking(workingWaitMs)
    return {
      accepted: status === "working" || status === "blocked",
      attempts,
      last_status: status,
    }
  })
}

/**
 * Resolve a pane for a role:
 * - reuse `prefer` if that pane_id is still alive
 * - otherwise split a new pane with a unique label
 *
 * Never claims an unrelated pane by scanning labels alone.
 */
function acquireRolePane(
  role: string,
  hostAdapter: ApneaHostAdapter,
  opts?: {
    prefer?: RolePaneRef | null
    /** Launch interactive harness only when creating a new pane */
    interactiveCmd?: string[]
  },
): Effect.Effect<RolePaneRef & { reused: boolean }, HerdrError> {
  return Effect.gen(function* () {
    if (!herdrEnabledSync()) {
      return yield* new HerdrError({
        message: "not inside Herdr (HERDR_ENV!=1); cannot manage panes",
      })
    }

    if (opts?.prefer?.pane_id && paneAliveSync(opts.prefer.pane_id)) {
      return {
        pane_id: opts.prefer.pane_id,
        label: opts.prefer.label,
        reused: true,
      }
    }

    const millis = yield* Clock.currentTimeMillis
    const label = roleLabel(role, millis)
    const split = yield* Effect.result(
      Effect.try({
        try: () => splitPaneSync(),
        catch: toHerdrError,
      }),
    )
    if (Result.isFailure(split)) {
      return yield* withLaunchDetails(split.failure, {
        delivery: "not_delivered",
        newly_created: false,
      })
    }
    const paneId = split.success
    const prepared = yield* Effect.result(
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => renamePaneSync(paneId, label),
          catch: toHerdrError,
        })
        if (!opts?.interactiveCmd?.length) return
        // Launch the interactive harness only (no task argv).
        // Pi roles get PI_CODING_AGENT_DIR without pi-vimmode so pane-run pastes
        // are not trapped in modal INSERT. Materializing that dir touches the
        // filesystem, so keep its failure a typed HerdrError, not a defect.
        const interactiveCmd = opts.interactiveCmd
        const launchCmd = yield* Effect.try({
          try: () =>
            hostAdapter.prepareInteractiveCommand?.(interactiveCmd) ??
            interactiveCmd,
          catch: toHerdrError,
        })
        const cmd = shellJoin(["cd", process.cwd(), "&&", "exec", ...launchCmd])
        yield* paneRun(paneId, cmd)
      }),
    )
    if (Result.isFailure(prepared)) {
      return yield* cleanupFailedInteractiveLaunch(prepared.failure, paneId)
    }
    return { pane_id: paneId, label, reused: false }
  })
}

/**
 * Open the interactive harness TUI in a pane (or reuse), wait until idle,
 * then submit a short pointer prompt via `pane run` (text + Enter).
 *
 * This is the Herdr-recommended path: live agent you can watch, not
 * `claude -p` / `pi -p` dumping shell output.
 */
function runInteractivePromptImpl(
  hostAdapter: ApneaHostAdapter,
  role: string,
  interactiveCmd: string[],
  prompt: string,
  prefer: RolePaneRef | null,
): Effect.Effect<InteractiveLaunch, HerdrError> {
  return Effect.gen(function* () {
    let preferUse: RolePaneRef | null = null
    if (prefer?.pane_id) {
      // One `pane get`: liveness and agent_status come from the same call.
      const info = paneGetSync(prefer.pane_id)
      // reuse only when a live agent can take a new prompt
      // working/blocked/unknown/shell-only → new pane
      if (
        info.ok &&
        (info.agent_status === "idle" || info.agent_status === "done")
      ) {
        preferUse = prefer
      }
    }

    const acquired = yield* acquireRolePane(role, hostAdapter, {
      prefer: preferUse,
      interactiveCmd: preferUse ? undefined : interactiveCmd,
    })

    if (!acquired.reused) {
      yield* waitAgentReady(acquired.pane_id, 90_000)
      // still try even if not idle/done — some harnesses accept input
      // before status settles.
    } else {
      const st = paneGetSync(acquired.pane_id).agent_status
      if (st !== "idle" && st !== "done") {
        yield* waitAgentReady(acquired.pane_id, 30_000)
      }
    }

    const beforePrompt = hostAdapter.beforeInteractivePrompt?.(interactiveCmd)
    if (beforePrompt) {
      // Host preparation is best-effort; command wrapping is the primary guard.
      yield* Effect.gen(function* () {
        yield* paneRun(acquired.pane_id, beforePrompt)
        yield* waitAgentReady(acquired.pane_id, 5_000)
        yield* Effect.sleep(300)
      }).pipe(Effect.ignore)
    }

    // Submit pointer into the live TUI (Herdr: pane run = text + Enter),
    // then confirm the agent actually started — do not trust fire-and-forget.
    const submitted = yield* Effect.result(paneRun(acquired.pane_id, prompt))
    if (Result.isFailure(submitted)) {
      return yield* withLaunchDetails(submitted.failure, {
        // The Herdr CLI can lose its response after the pane accepted text.
        // Closing or retrying here could kill or duplicate a live worker.
        delivery: "unknown",
        pane_id: acquired.pane_id,
        pane_label: acquired.label,
        reused: acquired.reused,
      })
    }
    const submit = yield* ensurePromptSubmitted(acquired.pane_id, prompt)
    return {
      pane_id: acquired.pane_id,
      label: acquired.label,
      reused: acquired.reused,
      prompt_accepted: submit.accepted,
      prompt_attempts: submit.attempts,
      last_status: submit.last_status,
    }
  })
}

/**
 * Thin Herdr service for pane lifecycle and interactive-prompt dispatch.
 * Depends on nothing, like `VcsLive`'s `run`.
 */
export const makeHerdrLive = (hostAdapter: ApneaHostAdapter) =>
  Layer.effect(
    Herdr,
    Effect.sync(() =>
      Herdr.of({
        enabled: Effect.sync(herdrEnabledSync),

        availability: Effect.try({
          try: herdrAvailabilitySync,
          catch: toHerdrError,
        }),

        paneGet: (paneId) => Effect.sync(() => paneGetSync(paneId)),

        paneRun,

        paneReadRecent: (paneId) =>
          Effect.try({
            try: () => paneReadRecentSync(paneId),
            catch: toHerdrError,
          }),

        paneForegroundNames: (paneId) =>
          Effect.sync(() => paneForegroundNamesSync(paneId)),

        runInteractivePrompt: (...args) =>
          runInteractivePromptImpl(hostAdapter, ...args),
      }),
    ),
  )

export const HerdrLive = makeHerdrLive(neutralHostAdapter)
