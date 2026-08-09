/**
 * Tmux pane-origin offset for absolute Kitty coordinates.
 *
 * Cache is keyed by OpenTUI **pre-offset** slot geometry so resize/layout
 * changes force a re-query even when wall-clock TTL would still allow a hit.
 */

export type SlotGeometry = {
  screenX: number
  screenY: number
  width: number
  height: number
}

export type TmuxOffset = { x: number; y: number }

export type TmuxOffsetQueryResult = {
  ok: boolean
  stdout: string
}

export type TmuxOffsetCache = {
  offset: TmuxOffset | null
  slot: SlotGeometry | null
}

const ZERO: TmuxOffset = { x: 0, y: 0 }

export function createTmuxOffsetCache(): TmuxOffsetCache {
  return { offset: null, slot: null }
}

/** True only when running under tmux without Herdr (Herdr already owns passthrough). */
export function shouldUseTmuxOffset(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.TMUX) && !env.HERDR_ENV
}

function slotKey(slot: SlotGeometry): string {
  return [slot.screenX, slot.screenY, slot.width, slot.height].join(":")
}

function sameSlotGeometry(
  a: SlotGeometry | null,
  b: SlotGeometry | null,
): boolean {
  if (a === null || b === null) return false
  return slotKey(a) === slotKey(b)
}

/**
 * Parse `tmux display-message -p '#{pane_left}\t#{pane_top}\t#{status-position}\t#{status}'`.
 * Status bar on top adds one row when status is not off.
 */
export function parseTmuxOffsetMessage(stdout: string): TmuxOffset {
  const [left, top, statusPosition, status] = stdout.trim().split("\t")
  return {
    x: Number.parseInt(left ?? "0", 10) || 0,
    y:
      (Number.parseInt(top ?? "0", 10) || 0) +
      (statusPosition === "top" && status !== "off" ? 1 : 0),
  }
}

function queryTmuxOffset(): TmuxOffsetQueryResult {
  const result = Bun.spawnSync([
    "tmux",
    "display-message",
    "-p",
    "#{pane_left}\t#{pane_top}\t#{status-position}\t#{status}",
  ])
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString(),
  }
}

/**
 * Resolve pane origin for absolute Kitty placement.
 *
 * - No TMUX / HERDR_ENV → zeros (no spawn).
 * - Slot geometry changed or first paint / empty cache → re-query.
 * - Identical slot + prior successful cache → reuse (no spawn).
 * - Failed query → zeros and clear cache so the next paint retries.
 */
export function resolveTerminalOffset(options: {
  env?: NodeJS.ProcessEnv
  slot: SlotGeometry | null
  cache: TmuxOffsetCache
  query?: () => TmuxOffsetQueryResult
}): TmuxOffset {
  const env = options.env ?? process.env
  if (!shouldUseTmuxOffset(env)) {
    options.cache.offset = null
    options.cache.slot = null
    return ZERO
  }

  if (
    options.cache.offset !== null &&
    options.slot !== null &&
    sameSlotGeometry(options.cache.slot, options.slot)
  ) {
    return options.cache.offset
  }

  const query = options.query ?? queryTmuxOffset
  const result = query()
  if (!result.ok) {
    options.cache.offset = null
    options.cache.slot = null
    return ZERO
  }

  const offset = parseTmuxOffsetMessage(result.stdout)
  options.cache.offset = offset
  options.cache.slot = options.slot ? { ...options.slot } : null
  return offset
}
