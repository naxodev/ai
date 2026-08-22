/**
 * Split `--bare` switches from `--key=value` options; everything else is
 * positional. `values` matters: `rest` never sees a `--`-prefixed token, so
 * `--key=value` options are only reachable through the map.
 */
export function parseFlags(tokens: string[]): {
  flags: Set<string>
  values: Map<string, string>
  rest: string[]
} {
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const rest: string[] = []
  let positionalOnly = false
  for (const t of tokens) {
    if (positionalOnly) {
      rest.push(t)
      continue
    }
    if (t === "--") {
      positionalOnly = true
      continue
    }
    if (!t.startsWith("--")) {
      rest.push(t)
      continue
    }
    const body = t.slice(2)
    const eq = body.indexOf("=")
    if (eq > 0) values.set(body.slice(0, eq), body.slice(eq + 1))
    else flags.add(body)
  }
  return { flags, values, rest }
}

type OperationArgSpec = {
  switches: readonly string[]
  values: readonly string[]
  minPositionals: number
  maxPositionals: number
}

const OPERATION_ARGS: Readonly<Record<string, OperationArgSpec>> = {
  setup: {
    switches: ["project", "force", "agents-md"],
    values: [],
    minPositionals: 0,
    maxPositionals: 0,
  },
  start: {
    switches: ["allow-dirty"],
    values: ["slug"],
    minPositionals: 1,
    maxPositionals: Number.POSITIVE_INFINITY,
  },
  resume: { switches: [], values: [], minPositionals: 0, maxPositionals: 0 },
  abandon: { switches: [], values: [], minPositionals: 0, maxPositionals: 0 },
  help: { switches: [], values: [], minPositionals: 0, maxPositionals: 0 },
  status: { switches: [], values: [], minPositionals: 0, maxPositionals: 0 },
  wait: {
    switches: [],
    values: ["poll", "budget", "timeout"],
    minPositionals: 0,
    maxPositionals: 0,
  },
  dispatch: {
    switches: ["rework"],
    values: [],
    minPositionals: 1,
    maxPositionals: 1,
  },
  commit: {
    switches: ["done"],
    values: [],
    minPositionals: 0,
    maxPositionals: Number.POSITIVE_INFINITY,
  },
  "reset-rounds": {
    switches: [],
    values: [],
    minPositionals: 1,
    maxPositionals: 1,
  },
}

export type ParsedOperationArgs =
  | {
      ok: true
      flags: Set<string>
      values: Map<string, string>
      positional: string[]
    }
  | { ok: false; message: string }

/**
 * Parse and validate one human-facing Apnea invocation. This is the shared
 * strict boundary for the standalone CLI and Pi's `/apnea` command.
 */
export function parseOperationArgs(
  verb: string,
  tokens: string[],
  options: { surface?: "cli" | "slash" } = {},
): ParsedOperationArgs {
  const spec = OPERATION_ARGS[verb]
  if (!spec) return { ok: false, message: `unknown command: ${verb}` }

  const allowedSwitches = new Set(spec.switches)
  if (options.surface === "cli") {
    allowedSwitches.add("json")
    if (verb === "reset-rounds") allowedSwitches.add("i-am-human")
  }
  const allowedValues = new Set(spec.values)
  const numericValues = new Set(["poll", "budget", "timeout"])
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const positional: string[] = []
  let positionalOnly = false

  for (const token of tokens) {
    if (positionalOnly) {
      positional.push(token)
      continue
    }
    if (token === "--") {
      positionalOnly = true
      continue
    }
    if (!token.startsWith("--")) {
      positional.push(token)
      continue
    }

    const body = token.slice(2)
    const equals = body.indexOf("=")
    const key = equals >= 0 ? body.slice(0, equals) : body
    const value = equals >= 0 ? body.slice(equals + 1) : undefined

    if (allowedSwitches.has(key)) {
      if (value !== undefined)
        return { ok: false, message: `option --${key} does not take a value` }
      if (flags.has(key))
        return {
          ok: false,
          message: `option --${key} was provided more than once`,
        }
      flags.add(key)
      continue
    }
    if (allowedValues.has(key)) {
      if (value === undefined)
        return { ok: false, message: `option --${key} requires =<value>` }
      if (numericValues.has(key)) {
        if (
          value === "" ||
          value.trim() !== value ||
          !Number.isFinite(Number(value))
        ) {
          return {
            ok: false,
            message: `invalid numeric option --${key}=${value}`,
          }
        }
      }
      if (values.has(key))
        return {
          ok: false,
          message: `option --${key} was provided more than once`,
        }
      values.set(key, value)
      continue
    }
    return { ok: false, message: `unknown option --${key} for ${verb}` }
  }

  if (
    positional.length < spec.minPositionals ||
    positional.length > spec.maxPositionals
  ) {
    return { ok: false, message: `invalid positional arguments for ${verb}` }
  }
  if (values.has("budget") && values.has("timeout")) {
    return {
      ok: false,
      message: "--budget and --timeout are aliases; provide only one",
    }
  }
  return { ok: true, flags, values, positional }
}

/** Reading a `--key=value` numeric flag either yields the parsed number (or
 * `undefined` when the caller didn't pass it) or the raw token that failed
 * to parse, so the caller can name exactly what it received. */
export type NumFlag =
  { ok: true; value: number | undefined } | { ok: false; raw: string }

/**
 * Shared by `/apnea` and the CLI so a mistyped `--budget=abc` is refused the
 * same way on both surfaces instead of silently falling back to a default —
 * a scripting agent needs a signal, not a quietly-wrong value. `--key=`
 * Strict human-facing parsing rejects empty numeric values before this helper.
 */
export function parseNumFlag(
  values: Map<string, string>,
  key: string,
): NumFlag {
  const raw = values.get(key)
  if (raw === undefined) return { ok: true, value: undefined }
  if (raw === "") return { ok: false, raw }
  const n = Number(raw)
  return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, raw }
}
