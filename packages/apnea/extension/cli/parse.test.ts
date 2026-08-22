import { describe, expect, test } from "bun:test"
import { parseFlags, parseOperationArgs } from "./parse.ts"

describe("parseFlags", () => {
  test("bare switches land in flags, positionals in rest", () => {
    const { flags, values, rest } = parseFlags([
      "code",
      "--rework",
      "extra words",
    ])
    expect(flags.has("rework")).toBe(true)
    expect(rest).toEqual(["code", "extra words"])
    expect(values.size).toBe(0)
  })

  // `rest` never sees a `--`-prefixed token, so a `--key=value` option is only
  // reachable through `values`. Reading it back out of `rest` silently drops
  // the option — `/apnea wait --timeout=3600000` would fall back to the
  // default budget instead of the caller's chosen one.
  test("--key=value options are exposed as values, never in rest", () => {
    const { flags, values, rest } = parseFlags(["--timeout=3600000"])
    expect(values.get("timeout")).toBe("3600000")
    expect(rest).toEqual([])
    expect(flags.size).toBe(0)
  })

  test("start-style mix: slug value, allow-dirty switch, goal words", () => {
    const { flags, values, rest } = parseFlags([
      "add",
      "--slug=my-run",
      "dark",
      "--allow-dirty",
      "mode",
    ])
    expect(values.get("slug")).toBe("my-run")
    expect(flags.has("allow-dirty")).toBe(true)
    expect(rest.join(" ")).toBe("add dark mode")
  })

  // `--=x` has no key; treating it as one would create an empty-named option.
  test("a leading = is not a key/value split", () => {
    const { flags, values } = parseFlags(["--=x"])
    expect(values.size).toBe(0)
    expect(flags.has("=x")).toBe(true)
  })
})

describe("parseOperationArgs", () => {
  test.each([
    ["dispatch", ["plan", "--rewrok"]],
    ["wait", ["--timeout", "60000"]],
    ["wait", ["--budget"]],
    ["wait", ["--budget="]],
    ["status", ["extra"]],
    ["help", ["extra"]],
    ["dispatch", ["plan", "extra"]],
    ["wait", ["--budget=1000", "--timeout=2000"]],
  ])("rejects invalid %s arguments: %j", (verb, argv) => {
    expect(parseOperationArgs(verb, argv).ok).toBe(false)
  })

  test("treats tokens after -- as literal start goal text", () => {
    const parsed = parseOperationArgs("start", ["--", "--ship", "safely"])
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.positional).toEqual(["--ship", "safely"])
  })

  test.each(["", " ", " 1", "1 ", "Infinity", "NaN"])(
    "rejects non-canonical numeric value %j",
    (value) => {
      expect(parseOperationArgs("wait", [`--budget=${value}`]).ok).toBe(false)
    },
  )

  test.each(["+1", "1e3", ".5", "0x10"])(
    "retains supported numeric syntax %s",
    (value) => {
      expect(parseOperationArgs("wait", [`--budget=${value}`]).ok).toBe(true)
    },
  )

  test("allows CLI-only flags only on their documented operations", () => {
    expect(
      parseOperationArgs("reset-rounds", ["gate", "--i-am-human", "--json"], {
        surface: "cli",
      }).ok,
    ).toBe(true)
    expect(
      parseOperationArgs("status", ["--i-am-human"], { surface: "cli" }).ok,
    ).toBe(false)
  })
})
