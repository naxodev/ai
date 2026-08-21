import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import type { ApneaConfig } from "../domain/types.ts"
import { expectFailure } from "../test/expect-failure.ts"
import {
  applyProjectConfig,
  decodeGlobalConfig,
  decodeProjectConfig,
  resolveRoleCmdResult,
  validateRoleBindings,
} from "./config.ts"

const base: ApneaConfig = {
  profiles: {
    pi: { cmd_interactive: ["pi"] },
    claude: {
      cmd_interactive: ["claude"],
      cmd_oneshot: ["claude", "-p"],
    },
  },
  roles: {
    planner: { profile: "pi" },
    reviewer: { profile: "pi" },
    coder: { profile: "pi" },
  },
  review_round_cap: 3,
  timeouts_ms: { verify: 900_000, coding: 2_700_000 },
}

const baseRawGlobal = {
  profiles: { pi: { cmd_interactive: ["pi"] } },
  roles: {
    planner: { profile: "pi" },
    reviewer: { profile: "pi" },
    coder: { profile: "pi" },
  },
}

describe("legacy pane_style migration", () => {
  test("global regular and floating values decode but disappear", () => {
    for (const pane_style of ["regular", "floating"] as const) {
      const r = decodeGlobalConfig({ ...baseRawGlobal, pane_style })
      expect(Result.isSuccess(r)).toBe(true)
      if (Result.isSuccess(r)) expect("pane_style" in r.success).toBe(false)
    }
  })

  test("invalid global legacy values still fail", () => {
    for (const pane_style of ["tiled", true, null]) {
      const error = expectFailure(
        decodeGlobalConfig({ ...baseRawGlobal, pane_style }),
        "ConfigError",
      )
      expect(error.message).toContain("pane_style")
      expect(error.message).toContain("regular")
      expect(error.message).toContain("floating")
    }
  })

  test("project regular and floating values decode but disappear", () => {
    for (const pane_style of ["regular", "floating"] as const) {
      const r = decodeProjectConfig({ pane_style, review_round_cap: 2 })
      expect(Result.isSuccess(r)).toBe(true)
      if (Result.isSuccess(r)) {
        expect(r.success.review_round_cap).toBe(2)
        expect("pane_style" in r.success).toBe(false)
      }
    }
  })

  test("invalid project legacy values still fail", () => {
    for (const pane_style of ["tiled", true, null]) {
      const error = expectFailure(
        decodeProjectConfig({ pane_style }),
        "ConfigError",
      )
      expect(error.message).toContain("pane_style")
      expect(error.message).toContain("regular")
      expect(error.message).toContain("floating")
    }
  })
})

describe("applyProjectConfig", () => {
  test("role override per-key; profiles untouched", () => {
    const merged = applyProjectConfig(base, {
      roles: { coder: { profile: "claude" } },
    })
    expect(merged.roles.coder).toEqual({ profile: "claude" })
    expect(merged.roles.planner).toEqual({ profile: "pi" })
    expect(merged.profiles).toBe(base.profiles)
    expect(merged.profiles).toEqual(base.profiles)
  })

  test("timeouts merge per-key", () => {
    const merged = applyProjectConfig(base, {
      timeouts_ms: { verify: 60_000 },
    })
    expect(merged.timeouts_ms.verify).toBe(60_000)
    expect(merged.timeouts_ms.coding).toBe(2_700_000)
  })

  test("review_round_cap falls back to base when absent", () => {
    const merged = applyProjectConfig(base, {})
    expect(merged.review_round_cap).toBe(3)
  })

  test("review_round_cap is taken from overlay when present", () => {
    const merged = applyProjectConfig(base, {
      review_round_cap: 5,
    })
    expect(merged.review_round_cap).toBe(5)
  })

  // Out-of-range overlay values fall back rather than propagate: a project
  // config is a shared, checked-in file, and cap=0 would deadlock every review.
  test("out-of-range overlay values fall back to base", () => {
    const merged = applyProjectConfig(base, {
      review_round_cap: 0,
      timeouts_ms: { verify: 500 },
    })
    expect(merged.review_round_cap).toBe(3)
    expect(merged.timeouts_ms.verify).toBe(900_000)
  })
})

/**
 * A hand-edited config with an out-of-range number must degrade to the default,
 * not fail the decode: `config.load` runs inside every tool, so a hard failure
 * here refuses workflow_start / dispatch_role / wait / commit alike, leaving no
 * way to recover from inside Pi.
 */
describe("out-of-range numbers degrade instead of failing the decode", () => {
  test("global timeouts_ms below the 1000ms floor fall back to defaults", () => {
    const r = decodeGlobalConfig({
      ...baseRawGlobal,
      timeouts_ms: { verify: 500, coding: 1_800_000 },
    })
    expect(Result.isSuccess(r)).toBe(true)
    if (Result.isSuccess(r)) {
      expect(r.success.timeouts_ms.verify).toBe(900_000) // DEFAULT_TIMEOUTS
      expect(r.success.timeouts_ms.coding).toBe(1_800_000) // in range, kept
    }
  })

  test("global review_round_cap below 1 falls back to 3", () => {
    const r = decodeGlobalConfig({ ...baseRawGlobal, review_round_cap: 0 })
    expect(Result.isSuccess(r)).toBe(true)
    if (Result.isSuccess(r)) expect(r.success.review_round_cap).toBe(3)
  })

  test("project overlay with an out-of-range number still decodes", () => {
    const r = decodeProjectConfig({
      review_round_cap: 0,
      timeouts_ms: { verify: 500 },
    })
    expect(Result.isSuccess(r)).toBe(true)
  })

  // Wrong *type* is still a hard failure — that is a malformed file, not a
  // value the defaults can stand in for.
  test("non-numeric timeout is still rejected", () => {
    const r = decodeGlobalConfig({
      ...baseRawGlobal,
      timeouts_ms: { verify: "900000" },
    })
    expect(Result.isFailure(r)).toBe(true)
  })
})

describe("validateRoleBindings", () => {
  test("explicit oneshot resolution remains available to external workflows", () => {
    const external = resolveRoleCmdResult(
      {
        ...base,
        roles: { ...base.roles, reviewer: { profile: "claude" } },
      },
      "reviewer",
      "oneshot",
    )
    expect(Result.isSuccess(external)).toBe(true)
    if (Result.isSuccess(external)) {
      expect(external.success).toEqual(["claude", "-p"])
    }
  })

  test("success returns cfg unchanged", () => {
    const r = validateRoleBindings(base)
    expect(Result.isSuccess(r)).toBe(true)
    if (Result.isSuccess(r)) expect(r.success).toBe(base)
  })

  test("missing role → ConfigError", () => {
    const cfg: ApneaConfig = {
      ...base,
      roles: { planner: { profile: "pi" }, reviewer: { profile: "pi" } },
    }
    const r = validateRoleBindings(cfg)
    expect(Result.isFailure(r)).toBe(true)
    if (Result.isFailure(r)) {
      expect(r.failure.message).toBe("config missing roles.coder")
    }
  })

  test("unknown profile → ConfigError", () => {
    const cfg: ApneaConfig = {
      ...base,
      roles: {
        ...base.roles,
        coder: { profile: "missing" },
      },
    }
    const r = validateRoleBindings(cfg)
    expect(Result.isFailure(r)).toBe(true)
    if (Result.isFailure(r)) {
      expect(r.failure.message).toBe(
        'roles.coder profile "missing" not defined in global profiles',
      )
    }
  })

  test("profile missing cmd for role mode → ConfigError", () => {
    // All roles are interactive in ROLE_MODE; use a profile with only oneshot.
    const cfg: ApneaConfig = {
      ...base,
      profiles: {
        oneshotOnly: { cmd_oneshot: ["x", "-p"] },
      },
      roles: {
        planner: { profile: "oneshotOnly" },
        reviewer: { profile: "oneshotOnly" },
        coder: { profile: "oneshotOnly" },
      },
    }
    const r = validateRoleBindings(cfg)
    expect(Result.isFailure(r)).toBe(true)
    if (Result.isFailure(r)) {
      expect(r.failure.message).toBe(
        'profile "oneshotOnly" missing cmd_interactive required by role planner',
      )
    }
  })
})
