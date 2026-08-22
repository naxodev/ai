import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { Result } from "effect"
import { LEGACY_CODE_REWORK } from "../domain/types.ts"
import {
  decodeGlobalConfig,
  decodeProjectConfig,
  GlobalConfigSchema,
} from "./config.ts"
import { decodeFrontMatterResult } from "./frontmatter.ts"
import { decodeRunState, RunStateSchema } from "./state.ts"

const repoRoot = path.resolve(import.meta.dir, "../..")

const fullState = {
  version: 1 as const,
  slug: "demo",
  step: "coding" as const,
  phase_index: 1,
  phase_count_hint: 3,
  rounds: { "phase-01/code_review": 2 },
  vcs: "jj" as const,
  allow_dirty: false,
  goal: "ship phase 1",
  last_error: null,
  pending_artifact: ".apnea/artifacts/phase-01/round-1/coder-result.md",
  pending_role: "coder" as const,
  pending_delivery: "interactive" as const,
  pending_pane_id: "p1",
  pending_pane_label: "apnea:coder:abc",
  role_panes: {
    coder: {
      pane_id: "p1",
      label: "apnea:coder:abc",
      profile_fingerprint: '["pi",["pi"]]',
    },
  },
  package_root: "/tmp/apnea",
  reviewer_tree_fingerprint: null,
  current_phase_package: ".apnea/artifacts/phase-01/round-1/phase-package.md",
  current_code_review: null,
  required_rework: null,
}

describe("RunStateSchema", () => {
  test("round-trips a full fixture", () => {
    const r = decodeRunState(fullState)
    expect(Result.isSuccess(r)).toBe(true)
    if (Result.isSuccess(r)) {
      expect(r.success.slug).toBe("demo")
      expect(r.success.pending_pane_id).toBe("p1")
      expect(r.success.pending_delivery).toBe("interactive")
      expect(r.success.role_panes.coder?.pane_id).toBe("p1")
    }
  })

  test("legacy fixture missing pane fields gets defaults", () => {
    const legacy = {
      version: 1,
      slug: "old",
      step: "planning",
      phase_index: 1,
      phase_count_hint: null,
      rounds: {},
      vcs: "git",
      allow_dirty: true,
      goal: "g",
      last_error: null,
      pending_artifact: null,
      pending_role: null,
      // no pending_pane_* or role_panes
      package_root: "/x",
      reviewer_tree_fingerprint: null,
      current_phase_package: null,
      current_code_review: null,
    }
    const r = decodeRunState(legacy)
    expect(Result.isSuccess(r)).toBe(true)
    if (Result.isSuccess(r)) {
      expect(r.success.pending_pane_id).toBeNull()
      expect(r.success.pending_pane_label).toBeNull()
      expect(r.success.pending_delivery).toBeNull()
      expect(r.success.role_panes).toEqual({})
      expect(r.success.required_rework).toBeNull()
    }
  })

  test("legacy remembered panes get a null profile fingerprint", () => {
    const r = decodeRunState({
      ...fullState,
      role_panes: { coder: { pane_id: "old", label: "apnea:coder:old" } },
    })
    expect(Result.isSuccess(r)).toBe(true)
    if (Result.isSuccess(r)) {
      expect(r.success.role_panes.coder?.profile_fingerprint).toBeNull()
    }
  })

  test("legacy pending delivery mode migrates only from a recorded pane", () => {
    const { pending_delivery: _pendingDelivery, ...legacy } = fullState
    const interactive = decodeRunState(legacy)
    const ambiguous = decodeRunState({
      ...legacy,
      pending_pane_id: null,
      pending_pane_label: null,
    })

    expect(Result.isSuccess(interactive)).toBe(true)
    expect(Result.isSuccess(ambiguous)).toBe(true)
    if (Result.isSuccess(interactive) && Result.isSuccess(ambiguous)) {
      expect(interactive.success.pending_delivery).toBe("interactive")
      expect(ambiguous.success.pending_delivery).toBeNull()
    }
  })

  test("a null legacy floating exit field decodes and is not retained", () => {
    const r = decodeRunState({ ...fullState, pending_floating_exit: null })
    expect(Result.isSuccess(r)).toBe(true)
    if (Result.isSuccess(r)) {
      expect("pending_floating_exit" in r.success).toBe(false)
    }
  })

  test("an active legacy floating dispatch fails instead of resuming its old deadline", () => {
    const r = decodeRunState({
      ...fullState,
      pending_floating_exit: ".apnea/tasks/old.exit",
    })
    expect(Result.isFailure(r)).toBe(true)
    if (Result.isFailure(r)) {
      expect(r.failure.message).toContain("floating dispatch was removed")
      expect(r.failure.message).toContain("`apnea abandon`")
      expect(r.failure.message).toContain('`apnea start "<goal>"`')
      const popupInstruction = r.failure.message.indexOf(
        "dismiss or terminate the old popup",
      )
      expect(popupInstruction).toBeGreaterThanOrEqual(0)
      expect(popupInstruction).toBeLessThan(
        r.failure.message.indexOf("`apnea abandon`"),
      )
      expect(r.failure.message.indexOf("`apnea abandon`")).toBeLessThan(
        r.failure.message.indexOf('`apnea start "<goal>"`'),
      )
    }
  })

  test("rejects version: 2 and garbage", () => {
    expect(Result.isFailure(decodeRunState({ version: 2 }))).toBe(true)
    expect(Result.isFailure(decodeRunState("nope"))).toBe(true)
    expect(Result.isFailure(decodeRunState({ ...fullState, version: 2 }))).toBe(
      true,
    )
  })

  test.each([
    ["phase_index", 0],
    ["phase_index", 1.5],
    ["phase_index", Infinity],
    ["phase_index", Number.MAX_SAFE_INTEGER + 1],
    ["phase_count_hint", -1],
    ["phase_count_hint", 0.5],
    ["pending_started_at", -1],
    ["pending_deadline_ms", 1.5],
    ["pending_nudged_at", Infinity],
  ])("rejects unsafe state numeric %s=%s", (field, value) => {
    expect(
      Result.isFailure(decodeRunState({ ...fullState, [field]: value })),
    ).toBe(true)
  })

  test.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe round value %s",
    (round) => {
      expect(
        Result.isFailure(
          decodeRunState({
            ...fullState,
            rounds: { "phase-01/code_review": round },
          }),
        ),
      ).toBe(true)
    },
  )

  test("accepts safe-integer state boundaries", () => {
    const result = decodeRunState({
      ...fullState,
      phase_count_hint: Number.MAX_SAFE_INTEGER,
      rounds: { "phase-01/code_review": Number.MAX_SAFE_INTEGER },
      pending_started_at: 0,
      pending_deadline_ms: Number.MAX_SAFE_INTEGER,
      pending_nudged_at: 0,
    })
    expect(Result.isSuccess(result)).toBe(true)
  })

  test.each([
    ["pending_artifact", "/tmp/artifact.md"],
    ["pending_artifact", ".apnea/../outside.md"],
    ["current_phase_package", "../phase-package.md"],
    ["current_code_review", ".apnea/artifacts/../../review.md"],
    ["pending_artifact", ".apnea/artifacts/unsafe\0.md"],
  ])("rejects escaped persisted artifact path %s=%s", (field, value) => {
    expect(
      Result.isFailure(decodeRunState({ ...fullState, [field]: value })),
    ).toBe(true)
  })

  test("legacy state without dispatch-clock fields decodes with defaults", () => {
    // A run started before the resumable-wait change must still load, or
    // upgrading mid-run would strand the user with a corrupt-state error.
    // `fullState` is the existing fixture; it predates the clock fields, which
    // is exactly the shape a mid-run upgrade encounters on disk.
    const r = decodeRunState({ ...fullState })
    expect(Result.isSuccess(r)).toBe(true)
    if (Result.isSuccess(r)) {
      expect(r.success.pending_started_at).toBeNull()
      expect(r.success.pending_deadline_ms).toBeNull()
      expect(r.success.pending_nudged_at).toBeNull()
      expect(r.success.pending_extended).toBe(false)
      // A `true` default here would skip the final-nudge rung on the first
      // deadline crossing of every pre-existing run, costing an idle role
      // its 180s grace with nothing to catch it.
      expect(r.success.pending_final_grace).toBe(false)
    }
  })

  test("migrates only explicit legacy package rework into an authoritative target", () => {
    const { required_rework: _requiredRework, ...legacyState } = fullState
    const packageRework = decodeRunState({
      ...legacyState,
      step: "phase_packaging",
      phase_package_rework: true,
    })
    const codeRework = decodeRunState({
      ...legacyState,
      step: "coding",
      current_code_review: ".apnea/artifacts/phase-01/round-1/code-review.md",
    })

    expect(Result.isSuccess(packageRework)).toBe(true)
    expect(Result.isSuccess(codeRework)).toBe(true)
    if (Result.isSuccess(packageRework) && Result.isSuccess(codeRework)) {
      expect(packageRework.success.required_rework).toBe("phase_package")
      expect(codeRework.success.required_rework).toBeNull()
      expect(codeRework.success[LEGACY_CODE_REWORK]).toBe(true)
      expect(
        Object.prototype.propertyIsEnumerable.call(
          codeRework.success,
          LEGACY_CODE_REWORK,
        ),
      ).toBe(false)
      expect("phase_package_rework" in packageRework.success).toBe(false)
    }
  })

  test("an explicit null target prevents legacy code inference", () => {
    const r = decodeRunState({
      ...fullState,
      step: "coding",
      required_rework: null,
      current_code_review: ".apnea/artifacts/phase-01/round-1/code-review.md",
    })

    expect(Result.isSuccess(r)).toBe(true)
    if (Result.isSuccess(r)) {
      expect(r.success.required_rework).toBeNull()
      expect(r.success[LEGACY_CODE_REWORK]).toBeUndefined()
    }
  })

  test("legacy coding with a matching coder dispatch already pending does not re-arm rework", () => {
    const { required_rework: _requiredRework, ...legacyState } = fullState
    const r = decodeRunState({
      ...legacyState,
      step: "coding",
      rounds: { "phase-01/code_review": 2 },
      pending_artifact: ".apnea/artifacts/phase-01/round-2/coder-result.md",
      pending_role: "coder",
      current_code_review: ".apnea/artifacts/phase-01/round-1/code-review.md",
    })

    expect(Result.isSuccess(r)).toBe(true)
    if (Result.isSuccess(r)) {
      expect(r.success.required_rework).toBeNull()
      expect(r.success[LEGACY_CODE_REWORK]).toBeUndefined()
    }
  })

  test("property names drift-guard vs schemas/state.schema.json", () => {
    const jsonPath = path.join(repoRoot, "schemas/state.schema.json")
    const doc = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as {
      properties: Record<string, unknown>
      required?: string[]
    }
    const deprecatedMigrationProperties = [
      "pending_floating_exit",
      "phase_package_rework",
    ]
    const jsonKeys = Object.keys(doc.properties)
      .filter((key) => !deprecatedMigrationProperties.includes(key))
      .sort()
    const schemaKeys = Object.keys(RunStateSchema.fields).sort()
    expect(schemaKeys).toEqual(jsonKeys)
    expect(
      Object.keys(doc.properties).filter((key) =>
        deprecatedMigrationProperties.includes(key),
      ),
    ).toEqual(deprecatedMigrationProperties)
    expect(doc.properties.pending_floating_exit).toMatchObject({
      type: "null",
      deprecated: true,
    })
    expect(doc.properties.phase_package_rework).toMatchObject({
      type: "boolean",
      deprecated: true,
    })
    expect(doc.required).not.toContain("pending_floating_exit")
    expect(doc.required).not.toContain("phase_package_rework")
  })

  test("published artifact path patterns reject NUL bytes", () => {
    const jsonPath = path.join(repoRoot, "schemas/state.schema.json")
    const doc = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as {
      properties: Record<string, { pattern?: string }>
    }
    for (const field of [
      "pending_artifact",
      "current_phase_package",
      "current_code_review",
    ]) {
      const pattern = doc.properties[field]?.pattern
      expect(pattern).toBeDefined()
      expect(new RegExp(pattern!).test(".apnea/artifacts/unsafe\0.md")).toBe(
        false,
      )
      expect(new RegExp(pattern!).test(".apnea/artifacts/safe.md")).toBe(true)
    }
  })
})

describe("config schemas", () => {
  test("global config decodes profiles/roles", () => {
    const r = decodeGlobalConfig({
      profiles: {
        pi: { cmd_interactive: ["pi"] },
      },
      roles: { planner: { profile: "pi" } },
      pane_style: "floating",
    })
    expect(Result.isSuccess(r)).toBe(true)
    if (Result.isSuccess(r)) {
      expect(r.success.profiles.pi?.cmd_interactive).toEqual(["pi"])
      expect(r.success.review_round_cap).toBe(3)
      expect("pane_style" in r.success).toBe(false)
    }
  })

  test("project config rejects unknown keys", () => {
    const r = decodeProjectConfig({ unknown_key: true })
    expect(Result.isFailure(r)).toBe(true)
    if (Result.isFailure(r)) {
      expect(r.failure._tag).toBe("ConfigError")
      expect(r.failure.message).toContain("unknown project config key")
    }
  })

  test("project config rejects profile-owned keys", () => {
    const r = decodeProjectConfig({ cmd_oneshot: ["x"] })
    expect(Result.isFailure(r)).toBe(true)
  })

  test("property names drift-guard vs schemas/config.schema.json", () => {
    const jsonPath = path.join(repoRoot, "schemas/config.schema.json")
    const doc = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as {
      properties: Record<string, unknown>
    }
    const deprecatedMigrationProperties = ["pane_style"]
    const jsonKeys = Object.keys(doc.properties)
      .filter((key) => !deprecatedMigrationProperties.includes(key))
      .sort()
    const schemaKeys = Object.keys(GlobalConfigSchema.fields).sort()
    expect(schemaKeys).toEqual(jsonKeys)
    expect(
      Object.keys(doc.properties).filter((key) =>
        deprecatedMigrationProperties.includes(key),
      ),
    ).toEqual(deprecatedMigrationProperties)
    expect(doc.properties.pane_style).toMatchObject({
      type: "string",
      enum: ["regular", "floating"],
      deprecated: true,
    })
  })
})

describe("frontmatter result schema", () => {
  test("accepts APPROVED verdict", () => {
    const r = decodeFrontMatterResult({ status: "done", verdict: "APPROVED" })
    expect(Result.isSuccess(r)).toBe(true)
  })

  test("accepts an explicit phase-package rework target", () => {
    const r = decodeFrontMatterResult({
      status: "done",
      verdict: "CHANGES_REQUIRED",
      rework: "phase_package",
    })
    expect(Result.isSuccess(r)).toBe(true)
  })

  test("rejects an unknown rework target", () => {
    const r = decodeFrontMatterResult({
      status: "done",
      verdict: "CHANGES_REQUIRED",
      rework: "planner",
    })
    expect(Result.isFailure(r)).toBe(true)
  })

  test("rejects verdict LGTM", () => {
    const r = decodeFrontMatterResult({ status: "done", verdict: "LGTM" })
    expect(Result.isFailure(r)).toBe(true)
  })
})
