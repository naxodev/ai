import * as fs from "node:fs"
import * as path from "node:path"
import { Clock, Context, Effect, Layer, Option, Result } from "effect"
import { shellJoin } from "../domain/herdr.ts"
import { HerdrError } from "../errors.ts"
import type { ApneaHostAdapter } from "../host-adapter.ts"
import { neutralHostAdapter } from "../host-adapter.ts"
import {
  Process,
  ProcessCancelledError,
  ProcessExitError,
  ProcessTimeoutError,
  type ProcessError,
  type ProcessService,
} from "./process.ts"

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
  readonly paneGet: (paneId: string) => Effect.Effect<PaneInfo, HerdrError>
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

const HERDR_QUERY_TIMEOUT_MS = 10_000
const HERDR_MUTATION_TIMEOUT_MS = 30_000
const HERDR_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024

type HerdrCliResult = { ok: boolean; json: unknown; raw: string }

function processRaw(error: ProcessError): string {
  return "stdout" in error ? `${error.stdout}${error.stderr}` : error.message
}

export function herdrCli(
  processService: ProcessService,
  args: string[],
  options: { mutation?: boolean; timeoutMs?: number } = {},
): Effect.Effect<HerdrCliResult, HerdrError> {
  const command = shellJoin(["herdr", ...args])
  return Effect.gen(function* () {
    const result = yield* Effect.result(
      processService.run({
        command: "herdr",
        args,
        timeoutMs: options.timeoutMs ?? HERDR_QUERY_TIMEOUT_MS,
        outputLimitBytes: HERDR_OUTPUT_LIMIT_BYTES,
      }),
    )
    if (Result.isFailure(result)) {
      const error = result.failure
      const raw = processRaw(error)
      if (error instanceof ProcessExitError) {
        return { ok: false, json: null, raw }
      }
      const deliveryUnknown =
        options.mutation &&
        (error instanceof ProcessTimeoutError ||
          error instanceof ProcessCancelledError)
      return yield* new HerdrError({
        message: `${command} failed: ${error.message}${raw ? `: ${raw.trim()}` : ""}`,
        command,
        details: {
          ...(deliveryUnknown ? { delivery: "unknown" } : {}),
          process_error: error._tag,
        },
      })
    }
    const raw = `${result.success.stdout}${result.success.stderr}`
    const line = result.success.stdout.trim().split(/\n/).filter(Boolean).pop()
    if (!line) {
      return yield* new HerdrError({
        message: `${command} returned no JSON output`,
        command,
      })
    }
    try {
      return { ok: true, json: JSON.parse(line), raw }
    } catch {
      return yield* new HerdrError({
        message: `${command} returned malformed JSON: ${raw.trim() || "empty output"}`,
        command,
      })
    }
  })
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

function herdrAvailability(
  processService: ProcessService,
): Effect.Effect<HerdrAvailability, HerdrError> {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
    return Effect.succeed("unavailable")
  }
  const current = process.env.HERDR_PANE_ID
  return Effect.gen(function* () {
    const r = yield* herdrCli(processService, ["pane", "get", current])
    if (r.ok) return "available"
    if (/pane_not_found|pane not found/i.test(r.raw)) return "unavailable"
    return yield* new HerdrError({
      message: `failed to verify current Herdr pane ${current}: ${r.raw.trim() || "unknown herdr error"}`,
      command: "herdr pane get",
    })
  })
}

export function paneGet(
  processService: ProcessService,
  paneId: string,
): Effect.Effect<PaneInfo, HerdrError> {
  return Effect.gen(function* () {
    const r = yield* herdrCli(processService, ["pane", "get", paneId])
    if (!r.ok) {
      return {
        ok: false,
        missing: /pane_not_found|pane not found/i.test(r.raw),
      }
    }
    const res = resultOf(r.json)
    if (!res?.pane || typeof res.pane !== "object") {
      return yield* new HerdrError({
        message: `herdr pane get returned no pane for ${paneId}`,
        command: "herdr pane get",
      })
    }
    const pane = res.pane as Record<string, unknown>
    return {
      ok: true,
      agent_status: pane.agent_status ? String(pane.agent_status) : undefined,
      label: pane.label ? String(pane.label) : undefined,
      agent: pane.agent ? String(pane.agent) : undefined,
    }
  })
}

function paneReadRecent(
  processService: ProcessService,
  paneId: string,
): Effect.Effect<string, HerdrError> {
  const args = paneReadRecentArgs(paneId)
  return Effect.gen(function* () {
    const r = yield* Effect.result(
      processService.run({
        command: "herdr",
        args,
        timeoutMs: HERDR_QUERY_TIMEOUT_MS,
        outputLimitBytes: HERDR_OUTPUT_LIMIT_BYTES,
      }),
    )
    if (Result.isFailure(r)) {
      const output = processRaw(r.failure)
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
    return r.success.stdout
  })
}

/** Prefer right on wide panes, down on tall/narrow ones. */
function splitDirection(
  processService: ProcessService,
): Effect.Effect<"right" | "down", HerdrError> {
  const current = process.env.HERDR_PANE_ID
  if (!current) return Effect.succeed("right")
  return Effect.gen(function* () {
    const r = yield* herdrCli(processService, [
      "pane",
      "layout",
      "--pane",
      current,
    ])
    const res = resultOf(r.json)
    const layout = res?.layout as Record<string, unknown> | undefined
    if (!Array.isArray(layout?.panes)) {
      return yield* new HerdrError({
        message: "herdr pane layout returned no panes",
        command: "herdr pane layout",
      })
    }
    const panes = layout.panes as Array<Record<string, unknown>>
    const me = panes.find((p) => String(p.pane_id) === current)
    const rect = me?.rect as { width?: number; height?: number } | undefined
    if (rect?.width != null && rect?.height != null) {
      return rect.width >= rect.height ? "right" : "down"
    }
    return "right"
  })
}

function splitPane(
  processService: ProcessService,
): Effect.Effect<string, HerdrError> {
  return Effect.gen(function* () {
    const direction = yield* splitDirection(processService)
    const r = yield* herdrCli(
      processService,
      ["pane", "split", "--current", "--direction", direction, "--no-focus"],
      { mutation: true },
    )
    if (!r.ok)
      return yield* new HerdrError({
        message: `herdr pane split failed: ${r.raw}`,
      })
    const res = resultOf(r.json)
    const pane = res?.pane as Record<string, unknown> | undefined
    const id = pane?.pane_id ? String(pane.pane_id) : null
    if (!id) {
      return yield* new HerdrError({
        message: `herdr pane split: no pane_id in ${r.raw}`,
      })
    }
    return id
  })
}

function renamePane(
  processService: ProcessService,
  paneId: string,
  label: string,
): Effect.Effect<void, HerdrError> {
  return Effect.gen(function* () {
    const r = yield* herdrCli(
      processService,
      ["pane", "rename", paneId, label],
      { mutation: true },
    )
    if (!r.ok) {
      return yield* new HerdrError({
        message: `herdr pane rename failed: ${r.raw}`,
      })
    }
  })
}

/**
 * Send text + Enter into a pane.
 * When a live agent TUI is focused, this submits a prompt (not a shell command).
 * When the pane is a bare shell, this runs a shell line.
 */
function paneRun(
  processService: ProcessService,
  paneId: string,
  command: string,
): Effect.Effect<void, HerdrError> {
  return Effect.gen(function* () {
    const r = yield* herdrCli(
      processService,
      ["pane", "run", paneId, command],
      { mutation: true },
    )
    if (!r.ok) {
      return yield* new HerdrError({
        message: `herdr pane run failed: ${r.raw}`,
        command: "herdr pane run",
      })
    }
  })
}

/** Send raw key names (e.g. Escape, Enter) into a pane. */
function paneSendKeys(
  processService: ProcessService,
  paneId: string,
  keys: string[],
): Effect.Effect<void, HerdrError> {
  if (keys.length === 0) return Effect.void
  return Effect.gen(function* () {
    const r = yield* herdrCli(
      processService,
      ["pane", "send-keys", paneId, ...keys],
      { mutation: true },
    )
    if (!r.ok) {
      return yield* new HerdrError({
        message: `herdr pane send-keys failed: ${r.raw}`,
      })
    }
  })
}

function paneForegroundNames(
  processService: ProcessService,
  paneId: string,
): Effect.Effect<string[]> {
  return Effect.gen(function* () {
    const r = yield* herdrCli(processService, [
      "pane",
      "process-info",
      "--pane",
      paneId,
    ])
    const res = resultOf(r.json)
    const processInfo = res?.process_info as Record<string, unknown> | undefined
    if (!Array.isArray(processInfo?.foreground_processes)) {
      return yield* new HerdrError({
        message: "herdr pane process-info returned no foreground_processes",
        command: "herdr pane process-info",
      })
    }
    const procs = processInfo.foreground_processes as Array<{
      name?: string
      argv0?: string
      cmdline?: string
    }>
    return procs.map((p) => p.cmdline || p.argv0 || p.name || "?")
  }).pipe(Effect.catch(() => Effect.succeed([])))
}

function toHerdrError(error: unknown): HerdrError {
  return error instanceof HerdrError
    ? error
    : new HerdrError({
        message: error instanceof Error ? error.message : String(error),
      })
}

function paneClose(
  processService: ProcessService,
  paneId: string,
): Effect.Effect<void, HerdrError> {
  return Effect.gen(function* () {
    const r = yield* herdrCli(processService, ["pane", "close", paneId], {
      mutation: true,
    })
    if (!r.ok) {
      return yield* new HerdrError({
        message: `herdr pane close failed: ${r.raw}`,
        command: "herdr pane close",
      })
    }
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
  close: (paneId: string) => Effect.Effect<void, HerdrError>,
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
  processService: ProcessService,
  paneId: string,
  timeoutMs = 90_000,
): Effect.Effect<string | undefined, HerdrError> {
  return Effect.gen(function* () {
    // Prefer Herdr's blocking wait (does not freeze our caller if we use it
    // only for short readiness; dispatch is already a tool call).
    const r = yield* herdrCli(
      processService,
      [
        "wait",
        "agent-status",
        paneId,
        "--status",
        "idle",
        "--timeout",
        String(timeoutMs),
      ],
      { timeoutMs: timeoutMs + 5_000 },
    )
    if (r.ok) {
      const s = (yield* paneGet(processService, paneId)).agent_status
      if (s === "idle" || s === "done") return s
    }
    // fall back: poll (done also counts as ready). Clock, not Date.now(): the
    // sleep below is virtualized under TestClock, so a wall-clock deadline
    // would never be reached in a test.
    const deadline =
      (yield* Clock.currentTimeMillis) + Math.min(timeoutMs, 30_000)
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const s = (yield* paneGet(processService, paneId)).agent_status
      if (s === "idle" || s === "done") return s
      yield* Effect.sleep(500)
    }
    return (yield* paneGet(processService, paneId)).agent_status
  })
}

/**
 * The three pane operations the recovery ladder drives.
 *
 * Injectable so the recovery ladder can be tested without a Herdr process.
 */
export type PromptProbes = {
  readonly status: () => Effect.Effect<string | undefined, HerdrError>
  readonly sendKeys: (keys: string[]) => Effect.Effect<void, HerdrError>
  readonly run: (text: string) => Effect.Effect<void, HerdrError>
}

function livePromptProbes(
  processService: ProcessService,
  paneId: string,
): PromptProbes {
  return {
    status: () =>
      Effect.map(paneGet(processService, paneId), (info) => info.agent_status),
    sendKeys: (keys) => paneSendKeys(processService, paneId, keys),
    run: (text) => paneRun(processService, paneId, text),
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
    processService?: ProcessService
  },
): Effect.Effect<
  {
    accepted: boolean
    attempts: number
    last_status?: string
  },
  HerdrError
> {
  return Effect.gen(function* () {
    const probes =
      opts?.probes ??
      (opts?.processService
        ? livePromptProbes(opts.processService, paneId)
        : undefined)
    if (!probes) {
      return yield* new HerdrError({
        message: "prompt probes or process service are required",
      })
    }
    const settleMs = opts?.settleMs ?? 2500
    const workingWaitMs = opts?.workingWaitMs ?? 12_000
    let attempts = 1

    const waitForWorking = (
      ms: number,
    ): Effect.Effect<string | undefined, HerdrError> =>
      Effect.gen(function* () {
        const deadline = (yield* Clock.currentTimeMillis) + ms
        while ((yield* Clock.currentTimeMillis) < deadline) {
          const s = yield* probes.status()
          if (s === "working" || s === "blocked") return s
          yield* Effect.sleep(400)
        }
        return yield* probes.status()
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
        last_status: yield* probes.status(),
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
  processService: ProcessService,
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

    if (
      opts?.prefer?.pane_id &&
      (yield* paneGet(processService, opts.prefer.pane_id)).ok
    ) {
      return {
        pane_id: opts.prefer.pane_id,
        label: opts.prefer.label,
        reused: true,
      }
    }

    const millis = yield* Clock.currentTimeMillis
    const label = roleLabel(role, millis)
    const split = yield* Effect.result(splitPane(processService))
    if (Result.isFailure(split)) {
      return yield* withLaunchDetails(split.failure, {
        delivery:
          split.failure.details?.delivery === "unknown"
            ? "unknown"
            : "not_delivered",
        newly_created: false,
      })
    }
    const paneId = split.success
    const prepared = yield* Effect.result(
      Effect.gen(function* () {
        yield* renamePane(processService, paneId, label)
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
        yield* paneRun(processService, paneId, cmd)
      }),
    )
    if (Result.isFailure(prepared)) {
      if (prepared.failure.details?.delivery === "unknown") {
        return yield* withLaunchDetails(prepared.failure, {
          delivery: "unknown",
          pane_id: paneId,
          pane_label: label,
          newly_created: true,
        })
      }
      return yield* cleanupFailedInteractiveLaunch(
        prepared.failure,
        paneId,
        (id) => paneClose(processService, id),
      )
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
  processService: ProcessService,
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
      const info = yield* paneGet(processService, prefer.pane_id)
      // reuse only when a live agent can take a new prompt
      // working/blocked/unknown/shell-only → new pane
      if (
        info.ok &&
        (info.agent_status === "idle" || info.agent_status === "done")
      ) {
        preferUse = prefer
      }
    }

    const acquired = yield* acquireRolePane(processService, role, hostAdapter, {
      prefer: preferUse,
      interactiveCmd: preferUse ? undefined : interactiveCmd,
    })

    if (!acquired.reused) {
      yield* waitAgentReady(processService, acquired.pane_id, 90_000)
      // still try even if not idle/done — some harnesses accept input
      // before status settles.
    } else {
      const st = (yield* paneGet(processService, acquired.pane_id)).agent_status
      if (st !== "idle" && st !== "done") {
        yield* waitAgentReady(processService, acquired.pane_id, 30_000)
      }
    }

    const beforePrompt = hostAdapter.beforeInteractivePrompt?.(interactiveCmd)
    if (beforePrompt) {
      // Host preparation is best-effort; command wrapping is the primary guard.
      yield* Effect.gen(function* () {
        yield* paneRun(processService, acquired.pane_id, beforePrompt)
        yield* waitAgentReady(processService, acquired.pane_id, 5_000)
        yield* Effect.sleep(300)
      }).pipe(Effect.ignore)
    }

    // Submit pointer into the live TUI (Herdr: pane run = text + Enter),
    // then confirm the agent actually started — do not trust fire-and-forget.
    const submitted = yield* Effect.result(
      paneRun(processService, acquired.pane_id, prompt),
    )
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
    const submit = yield* ensurePromptSubmitted(acquired.pane_id, prompt, {
      processService,
    })
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
    Effect.gen(function* () {
      const processService = yield* Process
      return Herdr.of({
        enabled: Effect.sync(herdrEnabledSync),

        availability: herdrAvailability(processService),

        paneGet: (paneId) => paneGet(processService, paneId),

        paneRun: (paneId, command) => paneRun(processService, paneId, command),

        paneReadRecent: (paneId) => paneReadRecent(processService, paneId),

        paneForegroundNames: (paneId) =>
          paneForegroundNames(processService, paneId),

        runInteractivePrompt: (...args) =>
          runInteractivePromptImpl(processService, hostAdapter, ...args),
      })
    }),
  )

export const HerdrLive = makeHerdrLive(neutralHostAdapter)
