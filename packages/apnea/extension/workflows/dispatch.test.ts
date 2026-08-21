import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "bun:test"
import { statePath } from "../domain/paths.ts"
import type { ApneaConfig, RunState } from "../domain/types.ts"
import { HerdrError, toToolResult } from "../errors.ts"
import { expectFailure } from "../test/expect-failure.ts"
import { fakeConfigLayer } from "../test/fake-config.ts"
import { makeFakeFileSystem } from "../test/fake-file-system.ts"
import { fakeHerdrLayer } from "../test/fake-herdr.ts"
import { fakeVcsLayer } from "../test/fake-vcs.ts"
import { itEffect } from "../test/it-effect.ts"
import { RunStoreLive } from "../services/run-store.ts"
import {
  applyProjectConfig,
  decodeGlobalConfig,
  decodeProjectConfig,
} from "../schema/config.ts"
import { briefFiles } from "../test/briefs.ts"
import { dispatchWorkflow } from "./dispatch.ts"

const ROOT = "/proj"

const INTERACTIVE_CFG: ApneaConfig = {
  profiles: { pi: { cmd_interactive: ["pi"], cmd_oneshot: ["pi", "-p"] } },
  roles: {
    planner: { profile: "pi" },
    reviewer: { profile: "pi" },
    coder: { profile: "pi" },
  },
  review_round_cap: 3,
  timeouts_ms: { verify: 900_000 },
}

/** Apnea dispatch cannot use a profile that only supports oneshot workflows. */
const NO_INTERACTIVE_CFG: ApneaConfig = {
  ...INTERACTIVE_CFG,
  profiles: { pi: { cmd_oneshot: ["pi", "-p"] } },
}

function baseState(overrides: Partial<RunState> = {}): RunState {
  return {
    version: 1,
    slug: "ex",
    step: "planning",
    phase_index: 1,
    phase_count_hint: null,
    rounds: {},
    vcs: "jj",
    allow_dirty: false,
    goal: "goal text",
    last_error: null,
    pending_artifact: null,
    pending_role: null,
    pending_pane_id: null,
    pending_pane_label: null,
    pending_started_at: null,
    pending_deadline_ms: null,
    pending_nudged_at: null,
    pending_final_grace: false,
    pending_extended: false,
    role_panes: {},
    package_root: "/pkg",
    reviewer_tree_fingerprint: null,
    current_phase_package: null,
    current_code_review: null,
    phase_package_rework: false,
    ...overrides,
  }
}

function seedFs(state: RunState, files: Record<string, string> = {}) {
  return makeFakeFileSystem({
    [statePath(ROOT)]: `${JSON.stringify(state, null, 2)}\n`,
    ...briefFiles("/pkg"),
    ...files,
  })
}

function layerOf(
  fakeFs: ReturnType<typeof makeFakeFileSystem>,
  opts: {
    vcs?: Parameters<typeof fakeVcsLayer>[0]
    cfg?: Parameters<typeof fakeConfigLayer>[0]
    herdr?: Parameters<typeof fakeHerdrLayer>[0]
  } = {},
) {
  const vcs = fakeVcsLayer(opts.vcs ?? {})
  const cfg = fakeConfigLayer(opts.cfg ?? {})
  const herdr = fakeHerdrLayer(opts.herdr ?? {})
  const layer = Layer.mergeAll(
    Layer.provideMerge(RunStoreLive, fakeFs.layer),
    cfg,
    vcs.layer,
    herdr.layer,
    TestClock.layer(),
  )
  return { layer, vcs: vcs.recorder, herdr: herdr.recorder, fakeFs }
}

function savedState(fakeFs: ReturnType<typeof makeFakeFileSystem>): RunState {
  return JSON.parse(fakeFs.files.get(statePath(ROOT))!) as RunState
}

function taskFiles(fakeFs: ReturnType<typeof makeFakeFileSystem>): string[] {
  return [...fakeFs.files.keys()].filter((file) =>
    file.includes("/.apnea/tasks/"),
  )
}

/** Runs dispatchWorkflow against a TestClock pinned to nowMs. */
async function runDispatch(
  params: Parameters<typeof dispatchWorkflow>[0],
  opts: {
    nowMs: number
    cfg?: ApneaConfig
    herdr?: Parameters<typeof fakeHerdrLayer>[0]
  },
): Promise<RunState> {
  const fsFake = seedFs(baseState({ step: "planning" }))
  const { layer, fakeFs } = layerOf(fsFake, {
    herdr: opts.herdr ?? {
      enabled: true,
      interactive: {
        pane_id: "pane-1",
        label: "apnea:planner:fake",
        reused: false,
        prompt_accepted: true,
        prompt_attempts: 1,
        last_status: "working",
      },
    },
    cfg: opts.cfg ?? {
      profiles: { pi: { cmd_interactive: ["pi"] } },
      roles: {
        planner: { profile: "pi" },
        reviewer: { profile: "pi" },
        coder: { profile: "pi" },
      },
      review_round_cap: 3,
      timeouts_ms: { planning: 1_500_000 },
    },
  })
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(opts.nowMs)
      yield* dispatchWorkflow(params, ROOT)
    }).pipe(Effect.provide(layer)),
  )
  return savedState(fakeFs)
}

describe("dispatchWorkflow (fake layers)", () => {
  itEffect("wrong step → IllegalTool", () => {
    const fsFake = seedFs(baseState({ step: "committing" }))
    const { layer } = layerOf(fsFake)
    return Effect.gen(function* () {
      const r = yield* Effect.result(dispatchWorkflow({ kind: "plan" }, ROOT))
      expectFailure(r, "IllegalTool")
    }).pipe(Effect.provide(layer))
  })

  itEffect(
    "kind not legal for step → IllegalKind carries the allowed set",
    () => {
      const fsFake = seedFs(baseState({ step: "planning" }))
      const { layer } = layerOf(fsFake)
      return Effect.gen(function* () {
        const r = yield* Effect.result(dispatchWorkflow({ kind: "code" }, ROOT))
        const e = expectFailure(r, "IllegalKind")
        expect(e.allowed).toEqual(["plan"])
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "no-herdr path writes the task file and sets pending fields with pending_pane_id null",
    () => {
      const fsFake = seedFs(baseState({ step: "planning" }))
      const { layer, fakeFs } = layerOf(fsFake, {
        herdr: { enabled: false },
      })
      return Effect.gen(function* () {
        const result = yield* dispatchWorkflow({ kind: "plan" }, ROOT)
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.data?.next).toBe("workflow_wait")
          const taskPath = String(result.data?.task)
          expect(fakeFs.files.has(`${ROOT}/${taskPath}`)).toBe(true)
        }
        const saved = savedState(fakeFs)
        // An operator must be able to launch the role by hand — a stray
        // pane id here would point at a pane Herdr never opened.
        expect(saved.pending_artifact).toBe(".apnea/artifacts/plan.md")
        expect(saved.pending_role).toBe("planner")
        expect(saved.pending_pane_id).toBeNull()
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "no-herdr dispatch's legal_next omits dispatch_role — a dispatch is already outstanding",
    () => {
      // `nextAfter(state.step)` would return ["dispatch_role", "workflow_wait"]
      // at step=planning: it is step-derived and has no idea a dispatch is
      // in flight. An agent following legal_next literally would fire a
      // second dispatch that overwrites pending_artifact/pending_role and
      // orphans the first role's in-flight work.
      const fsFake = seedFs(baseState({ step: "planning" }))
      const { layer } = layerOf(fsFake, { herdr: { enabled: false } })
      return Effect.gen(function* () {
        const result = yield* dispatchWorkflow({ kind: "plan" }, ROOT)
        expect(result.ok).toBe(true)
        expect(result.legal_next).toEqual(["workflow_wait"])
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect("rework:true on code bumps phase-01/code_review by one", () => {
    const fsFake = seedFs(
      baseState({ step: "coding", rounds: { "phase-01/code_review": 2 } }),
    )
    const { layer, fakeFs } = layerOf(fsFake, { herdr: { enabled: false } })
    return Effect.gen(function* () {
      const result = yield* dispatchWorkflow(
        { kind: "code", rework: true },
        ROOT,
      )
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.data?.round).toBe(3)
      expect(savedState(fakeFs).rounds["phase-01/code_review"]).toBe(3)
    }).pipe(Effect.provide(layer))
  })

  itEffect(
    "a non-rework code dispatch does not bump the round (round inflation would burn the cap)",
    () => {
      const fsFake = seedFs(
        baseState({ step: "coding", rounds: { "phase-01/code_review": 2 } }),
      )
      const { layer, fakeFs } = layerOf(fsFake, { herdr: { enabled: false } })
      return Effect.gen(function* () {
        const result = yield* dispatchWorkflow({ kind: "code" }, ROOT)
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.data?.round).toBe(2)
        expect(savedState(fakeFs).rounds["phase-01/code_review"]).toBe(2)
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect("round over review_round_cap → GateRefused round_cap", () => {
    const fsFake = seedFs(
      baseState({ step: "coding", rounds: { "phase-01/code_review": 4 } }),
    )
    const { layer } = layerOf(fsFake, { herdr: { enabled: false } })
    return Effect.gen(function* () {
      const r = yield* Effect.result(dispatchWorkflow({ kind: "code" }, ROOT))
      const e = expectFailure(r, "GateRefused")
      expect(e.gate).toBe("round_cap")
    }).pipe(Effect.provide(layer))
  })

  itEffect(
    "reviewer dispatch records reviewer_tree_fingerprint (dirty-reviewer check is worthless without it)",
    () => {
      const fsFake = seedFs(baseState({ step: "plan_review" }))
      const { layer, fakeFs } = layerOf(fsFake, {
        herdr: { enabled: false },
        vcs: { fingerprint: "M some/file.ts" },
      })
      return Effect.gen(function* () {
        const result = yield* dispatchWorkflow({ kind: "plan_review" }, ROOT)
        expect(result.ok).toBe(true)
        expect(savedState(fakeFs).reviewer_tree_fingerprint).toBe(
          "M some/file.ts",
        )
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "an existing artifact is renamed to .bak.<millis> before dispatch (stale artifacts would be read as fresh by wait)",
    () => {
      const artifactPath = `${ROOT}/.apnea/artifacts/plan.md`
      const fsFake = seedFs(baseState({ step: "planning" }), {
        [artifactPath]: "stale content",
      })
      const { layer, fakeFs } = layerOf(fsFake, { herdr: { enabled: false } })
      return Effect.gen(function* () {
        const result = yield* dispatchWorkflow({ kind: "plan" }, ROOT)
        expect(result.ok).toBe(true)
        expect(fakeFs.files.has(artifactPath)).toBe(false)
        const backups = [...fakeFs.files.keys()].filter((k) =>
          k.startsWith(`${artifactPath}.bak.`),
        )
        expect(backups.length).toBe(1)
        expect(fakeFs.files.get(backups[0]!)).toBe("stale content")
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "interactive path sets role_panes[role] and pending_pane_id from the fake launch",
    () => {
      const fsFake = seedFs(baseState({ step: "planning" }))
      const { layer, fakeFs, herdr } = layerOf(fsFake, {
        herdr: {
          enabled: true,
          interactive: {
            pane_id: "pane-42",
            label: "apnea:planner:abc",
            reused: false,
            prompt_accepted: true,
            prompt_attempts: 1,
            last_status: "working",
          },
        },
      })
      return Effect.gen(function* () {
        const result = yield* dispatchWorkflow({ kind: "plan" }, ROOT)
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.data?.launch).toMatchObject({
            pane_id: "pane-42",
            mode: "interactive",
          })
        }
        expect(herdr.interactiveCalls.length).toBe(1)
        const saved = savedState(fakeFs)
        expect(saved.pending_pane_id).toBe("pane-42")
        expect(saved.role_panes.planner).toEqual({
          pane_id: "pane-42",
          label: "apnea:planner:abc",
          profile_fingerprint: '["pi",["pi"]]',
        })
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "reuses a role pane only while its effective profile and command match",
    () => {
      const matching = {
        pane_id: "pane-old",
        label: "apnea:planner:old",
        profile_fingerprint: '["pi",["pi"]]',
      }
      const matchingFs = seedFs(
        baseState({ step: "planning", role_panes: { planner: matching } }),
      )
      const profileChangedFs = seedFs(
        baseState({ step: "planning", role_panes: { planner: matching } }),
      )
      const commandChangedFs = seedFs(
        baseState({ step: "planning", role_panes: { planner: matching } }),
      )
      const same = layerOf(matchingFs)
      const profileChanged = layerOf(profileChangedFs, {
        cfg: {
          profiles: { alternate: { cmd_interactive: ["pi"] } },
          roles: {
            planner: { profile: "alternate" },
            reviewer: { profile: "alternate" },
            coder: { profile: "alternate" },
          },
          review_round_cap: 3,
          timeouts_ms: {},
        },
      })
      const commandChanged = layerOf(commandChangedFs, {
        cfg: {
          profiles: { pi: { cmd_interactive: ["pi", "--new"] } },
          roles: {
            planner: { profile: "pi" },
            reviewer: { profile: "pi" },
            coder: { profile: "pi" },
          },
          review_round_cap: 3,
          timeouts_ms: {},
        },
      })
      return Effect.gen(function* () {
        yield* dispatchWorkflow({ kind: "plan" }, ROOT).pipe(
          Effect.provide(same.layer),
        )
        yield* dispatchWorkflow({ kind: "plan" }, ROOT).pipe(
          Effect.provide(profileChanged.layer),
        )
        yield* dispatchWorkflow({ kind: "plan" }, ROOT).pipe(
          Effect.provide(commandChanged.layer),
        )
        expect(same.herdr.interactiveCalls[0]?.prefer).toEqual(matching)
        expect(profileChanged.herdr.interactiveCalls[0]?.prefer).toBeNull()
        expect(commandChanged.herdr.interactiveCalls[0]?.prefer).toBeNull()
        expect(
          savedState(profileChanged.fakeFs).role_panes.planner
            ?.profile_fingerprint,
        ).toBe('["alternate",["pi"]]')
        expect(
          savedState(commandChanged.fakeFs).role_panes.planner
            ?.profile_fingerprint,
        ).toBe('["pi",["pi","--new"]]')
      })
    },
  )

  itEffect(
    "a stale current Herdr pane falls back to one manual-launch task",
    () => {
      const fsFake = seedFs(baseState({ step: "planning" }))
      const { layer, fakeFs, herdr } = layerOf(fsFake, {
        herdr: { enabled: true, availability: "unavailable" },
      })
      return Effect.gen(function* () {
        const result = yield* dispatchWorkflow({ kind: "plan" }, ROOT)
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.message).toContain("no Herdr")
        expect(herdr.interactiveCalls).toHaveLength(0)
        expect(
          [...fakeFs.files.keys()].filter((file) =>
            file.includes("/.apnea/tasks/"),
          ),
        ).toHaveLength(1)
        expect(savedState(fakeFs).pending_pane_id).toBeNull()
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect("a genuine Herdr preflight failure writes no task", () => {
    const fsFake = seedFs(baseState({ step: "planning" }))
    const { layer, fakeFs } = layerOf(fsFake, {
      herdr: {
        availability: new HerdrError({ message: "herdr daemon unavailable" }),
      },
    })
    return Effect.gen(function* () {
      const result = yield* Effect.result(
        dispatchWorkflow({ kind: "plan" }, ROOT),
      )
      expect(expectFailure(result, "HerdrError").message).toBe(
        "herdr daemon unavailable",
      )
      expect(
        [...fakeFs.files.keys()].some((file) =>
          file.includes("/.apnea/tasks/"),
        ),
      ).toBe(false)
    }).pipe(Effect.provide(layer))
  })

  itEffect(
    "package rework advances the review round and preserves the prior package",
    () => {
      const oldPackage = `${ROOT}/.apnea/artifacts/phase-01/round-1/phase-package.md`
      const fsFake = seedFs(
        baseState({
          step: "phase_packaging",
          rounds: { "phase-01/code_review": 1 },
          current_phase_package:
            ".apnea/artifacts/phase-01/round-1/phase-package.md",
          current_code_review:
            ".apnea/artifacts/phase-01/round-1/code-review.md",
          phase_package_rework: true,
        }),
        { [oldPackage]: "old package" },
      )
      const { layer, fakeFs } = layerOf(fsFake, { herdr: { enabled: false } })
      return Effect.gen(function* () {
        const result = yield* dispatchWorkflow({ kind: "phase_package" }, ROOT)
        expect(result.ok).toBe(true)
        expect(result.data?.round).toBe(2)
        expect(result.data?.artifact).toBe(
          ".apnea/artifacts/phase-01/round-2/phase-package.md",
        )
        expect(fakeFs.files.get(oldPackage)).toBe("old package")
        const saved = savedState(fakeFs)
        expect(saved.rounds["phase-01/code_review"]).toBe(2)
        expect(saved.phase_package_rework).toBe(false)
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "package rework at the round cap refuses without changing any workflow artifact or state",
    () => {
      const oldPackage = `${ROOT}/.apnea/artifacts/phase-01/round-3/phase-package.md`
      const state = baseState({
        step: "phase_packaging",
        rounds: { "phase-01/code_review": 3 },
        current_phase_package:
          ".apnea/artifacts/phase-01/round-3/phase-package.md",
        current_code_review: ".apnea/artifacts/phase-01/round-3/code-review.md",
        phase_package_rework: true,
      })
      const fsFake = seedFs(state, { [oldPackage]: "prior package" })
      const before = new Map(fsFake.files)
      const { layer, fakeFs } = layerOf(fsFake, { herdr: { enabled: false } })
      return Effect.gen(function* () {
        const result = yield* Effect.result(
          dispatchWorkflow({ kind: "phase_package" }, ROOT),
        )
        const error = expectFailure(result, "GateRefused")
        expect(error.gate).toBe("round_cap")
        expect(fakeFs.files).toEqual(before)
        const saved = savedState(fakeFs)
        expect(saved.rounds["phase-01/code_review"]).toBe(3)
        expect(saved.phase_package_rework).toBe(true)
        expect(saved.current_phase_package).toBe(
          ".apnea/artifacts/phase-01/round-3/phase-package.md",
        )
        expect(taskFiles(fakeFs)).toEqual([])
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "interactive dispatch's legal_next omits dispatch_role — a dispatch is already outstanding",
    () => {
      // Same reasoning as the no-herdr branch's legal_next test above: this
      // is the OTHER `ok(...)` return site in dispatch.ts, and both must
      // agree that `workflow_wait` is the only legal next call.
      const fsFake = seedFs(baseState({ step: "planning" }))
      const { layer } = layerOf(fsFake, {
        herdr: {
          enabled: true,
          interactive: {
            pane_id: "pane-42",
            label: "apnea:planner:abc",
            reused: false,
            prompt_accepted: true,
            prompt_attempts: 1,
            last_status: "working",
          },
        },
      })
      return Effect.gen(function* () {
        const result = yield* dispatchWorkflow({ kind: "plan" }, ROOT)
        expect(result.ok).toBe(true)
        expect(result.legal_next).toEqual(["workflow_wait"])
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "legacy floating project config cannot change any role from reusable interactive dispatch",
    () => {
      const global = decodeGlobalConfig({
        profiles: {
          pi: {
            cmd_interactive: ["pi", "--interactive"],
            cmd_oneshot: ["pi", "-p"],
          },
        },
        roles: INTERACTIVE_CFG.roles,
      })
      const project = decodeProjectConfig({ pane_style: "floating" })
      if (global._tag === "Failure" || project._tag === "Failure") {
        throw new Error("legacy config fixture must decode")
      }
      const cfg = applyProjectConfig(global.success, project.success)
      const cases = [
        {
          step: "planning" as const,
          kind: "plan" as const,
          role: "planner" as const,
        },
        {
          step: "plan_review" as const,
          kind: "plan_review" as const,
          role: "reviewer" as const,
        },
        {
          step: "coding" as const,
          kind: "code" as const,
          role: "coder" as const,
        },
      ]

      return Effect.gen(function* () {
        for (const testCase of cases) {
          const remembered = {
            pane_id: `pane-${testCase.role}`,
            label: `apnea:${testCase.role}:existing`,
            profile_fingerprint: '["pi",["pi","--interactive"]]',
          }
          const fsFake = seedFs(
            baseState({
              step: testCase.step,
              role_panes: { [testCase.role]: remembered },
            }),
          )
          const testLayer = layerOf(fsFake, {
            cfg,
            herdr: {
              interactive: {
                pane_id: remembered.pane_id,
                label: remembered.label,
                reused: true,
                prompt_accepted: true,
                prompt_attempts: 1,
                last_status: "working",
              },
            },
          })
          const result = yield* dispatchWorkflow(
            { kind: testCase.kind },
            ROOT,
          ).pipe(Effect.provide(testLayer.layer))
          expect(testLayer.herdr.interactiveCalls).toHaveLength(1)
          expect(testLayer.herdr.interactiveCalls[0]).toMatchObject({
            role: testCase.role,
            cmd: ["pi", "--interactive"],
            prefer: remembered,
          })
          expect(result.data?.launch).toMatchObject({
            mode: "interactive",
            reused: true,
          })
          const launch = result.data?.launch as Record<string, unknown>
          expect("pane_style" in launch).toBe(false)
        }
      })
    },
  )

  itEffect(
    "oneshot-only profile refuses before writing a task even without Herdr",
    () => {
      const fsFake = seedFs(baseState({ step: "planning" }))
      const { layer, fakeFs } = layerOf(fsFake, {
        herdr: { enabled: false },
        cfg: NO_INTERACTIVE_CFG,
      })
      return Effect.gen(function* () {
        const r = yield* Effect.result(dispatchWorkflow({ kind: "plan" }, ROOT))
        const e = expectFailure(r, "ConfigError")
        expect(e.message).toContain("cmd_interactive")
        expect(taskFiles(fakeFs)).toEqual([])

        const out = toToolResult(e)
        expect(out.ok).toBe(false)
        expect(out.data?.task).toBeUndefined()
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "late interactive launch failure restores the exact pre-dispatch files",
    () => {
      const artifact = `${ROOT}/.apnea/artifacts/plan.md`
      const fsFake = seedFs(baseState({ step: "planning" }), {
        [artifact]: "prior plan",
      })
      const before = new Map(fsFake.files)
      const { layer, fakeFs } = layerOf(fsFake, {
        herdr: {
          enabled: true,
          interactive: new HerdrError({ message: "pane split failed" }),
        },
      })
      return Effect.gen(function* () {
        const r = yield* Effect.result(dispatchWorkflow({ kind: "plan" }, ROOT))
        const e = expectFailure(r, "HerdrError")
        expect(e.message).toBe("pane split failed")
        expect(e.details).toMatchObject({
          artifact: ".apnea/artifacts/plan.md",
          rolled_back: true,
        })
        expect(fakeFs.files).toEqual(before)
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "ambiguous pane-run failure preserves task, pending state, and retry ownership",
    () => {
      const error = new HerdrError({
        message: "herdr pane run failed: response lost",
        command: "herdr pane run",
        details: {
          delivery: "unknown",
          pane_id: "pane-42",
          pane_label: "apnea:planner:abc",
          reused: false,
        },
      })
      const fsFake = seedFs(baseState({ step: "planning" }))
      const first = layerOf(fsFake, { herdr: { interactive: error } })
      return Effect.gen(function* () {
        const result = yield* Effect.result(
          dispatchWorkflow({ kind: "plan" }, ROOT),
        )
        const failure = expectFailure(result, "HerdrError")
        expect(failure.message).toContain("response lost")
        expect(failure.details).toMatchObject({
          delivery: "unknown",
          pending_preserved: true,
        })
        const saved = savedState(fsFake)
        expect(saved.pending_artifact).toBe(".apnea/artifacts/plan.md")
        expect(saved.pending_pane_id).toBe("pane-42")
        expect(taskFiles(fsFake)).toHaveLength(1)

        const retry = layerOf(fsFake)
        const retried = yield* Effect.result(
          dispatchWorkflow({ kind: "plan" }, ROOT).pipe(
            Effect.provide(retry.layer),
          ),
        )
        const retryFailure = expectFailure(retried, "GateRefused")
        expect(retryFailure.gate).toBe("dispatch_pending")
        expect(retry.herdr.interactiveCalls).toHaveLength(0)
        expect(taskFiles(fsFake)).toHaveLength(1)
      }).pipe(Effect.provide(first.layer))
    },
  )

  itEffect(
    "definite launch failure reports rollback cleanup failure without hiding launch error",
    () => {
      const fsFake = makeFakeFileSystem(
        {
          [statePath(ROOT)]: `${JSON.stringify(baseState(), null, 2)}\n`,
          ...briefFiles("/pkg"),
        },
        {
          failRemove: (path) =>
            path.includes("/.apnea/tasks/") && path.endsWith(".md")
              ? new Error("cleanup disk failure")
              : null,
        },
      )
      const { layer } = layerOf(fsFake, {
        herdr: {
          interactive: new HerdrError({
            message: "pane split failed",
            details: { delivery: "not_delivered" },
          }),
        },
      })
      return Effect.gen(function* () {
        const result = yield* Effect.result(
          dispatchWorkflow({ kind: "plan" }, ROOT),
        )
        const failure = expectFailure(result, "HerdrError")
        expect(failure.message).toBe("pane split failed")
        expect(failure.details?.rolled_back).toBe(false)
        expect(failure.details?.rollback_errors).toEqual([
          expect.stringContaining("cleanup disk failure"),
        ])
        expect(savedState(fsFake).pending_artifact).toBeNull()
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "pending-state persistence failure restores files and never launches a worker",
    () => {
      const artifact = `${ROOT}/.apnea/artifacts/plan.md`
      const state = baseState()
      const fsFake = makeFakeFileSystem(
        {
          [statePath(ROOT)]: `${JSON.stringify(state, null, 2)}\n`,
          [artifact]: "prior plan",
          ...briefFiles("/pkg"),
        },
        {
          failWrite: (path) =>
            path === statePath(ROOT) ? new Error("state disk full") : null,
        },
      )
      const { layer, herdr } = layerOf(fsFake)
      return Effect.gen(function* () {
        const result = yield* Effect.result(
          dispatchWorkflow({ kind: "plan" }, ROOT),
        )
        const failure = expectFailure(result, "HerdrError")
        expect(failure.message).toContain("state disk full")
        expect(failure.details?.rolled_back).toBe(true)
        expect(herdr.interactiveCalls).toHaveLength(0)
        expect(fsFake.files.get(artifact)).toBe("prior plan")
        expect(taskFiles(fsFake)).toEqual([])
        expect(savedState(fsFake)).toEqual(state)
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "pre-write refusal carries no task/artifact and writes no task file",
    () => {
      // kind=code at step=planning fails before the task file is written.
      const fsFake = seedFs(baseState({ step: "planning" }))
      const { layer, fakeFs } = layerOf(fsFake)
      return Effect.gen(function* () {
        const r = yield* Effect.result(dispatchWorkflow({ kind: "code" }, ROOT))
        const e = expectFailure(r, "IllegalKind")
        const out = toToolResult(e)
        expect(out.data?.task).toBeUndefined()
        expect(out.data?.artifact).toBeUndefined()
        expect(
          [...fakeFs.files.keys()].some((k) => k.includes("/.apnea/tasks/")),
        ).toBe(false)
      }).pipe(Effect.provide(layer))
    },
  )

  test("dispatch stamps the clock so a later wait can resume the budget", async () => {
    // Without a persisted start and deadline, every fresh `apnea wait`
    // process would restart the timeout and a hung role would never fail.
    const now = 1_700_000_000_000
    const state = await runDispatch({ kind: "plan" }, { nowMs: now })
    expect(state.pending_started_at).toBe(now)
    expect(state.pending_deadline_ms).toBe(now + 1_500_000)
    expect(state.pending_nudged_at).toBeNull()
    expect(state.pending_extended).toBe(false)
  })

  itEffect(
    "dispatch clears every recovery-ladder flag the previous role left behind",
    () => {
      // The ladder's flags are one-shot per dispatch. A flag that survives
      // into the next role silently disables that role's recovery: a stale
      // `pending_final_grace` skips its final nudge and 180s grace, a stale
      // `pending_nudged_at` skips its idle nudge, a stale `pending_extended`
      // denies its one-time extension. Nothing else in the suite covers
      // this — deleting a line from `resetRecoveryLadder` left the whole
      // suite green.
      //
      // BOTH save paths, because `dispatch` resets the ladder twice: once
      // on the manual-launch branch (no herdr) and once on the herdr
      // branch. The first version of this test ran only `enabled: false`,
      // so deleting the reset from the herdr path — the one every real run
      // takes — still passed.
      const seed = () =>
        seedFs(
          baseState({
            step: "planning",
            pending_nudged_at: 1_234,
            pending_final_grace: true,
            pending_extended: true,
          }),
        )
      const manual = layerOf(seed(), { herdr: { enabled: false } })
      const viaHerdr = layerOf(seed(), { herdr: { enabled: true } })
      const assertCleared = (fakeFs: ReturnType<typeof seedFs>) => {
        const saved = savedState(fakeFs)
        expect(saved.pending_nudged_at).toBeNull()
        expect(saved.pending_final_grace).toBe(false)
        expect(saved.pending_extended).toBe(false)
      }
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* dispatchWorkflow({ kind: "plan" }, ROOT)
          assertCleared(manual.fakeFs)
        }).pipe(Effect.provide(manual.layer))
        yield* Effect.gen(function* () {
          yield* dispatchWorkflow({ kind: "plan" }, ROOT)
          assertCleared(viaHerdr.fakeFs)
        }).pipe(Effect.provide(viaHerdr.layer))
      })
    },
  )

  test("no-Herdr dispatch also stamps the clock (manual launch still owes wait a deadline)", async () => {
    // This branch tells the operator to launch the role by hand and then
    // call workflow_wait. It offers the same workflow_wait contract as the
    // Herdr-driven branches, so it must not be the one path left with a
    // null deadline that silently falls back to the un-timed default.
    const now = 1_700_000_000_000
    const state = await runDispatch(
      { kind: "plan" },
      { nowMs: now, herdr: { enabled: false } },
    )
    expect(state.pending_started_at).toBe(now)
    expect(state.pending_deadline_ms).toBe(now + 1_500_000)
    expect(state.pending_nudged_at).toBeNull()
    expect(state.pending_extended).toBe(false)
  })

  test("a slow interactive launch does not eat into the role's deadline (pending_started_at anchors after the launch, not before)", async () => {
    // `pending_started_at` is the anchor for both the role's own deadline
    // and wait's 12s liveness grace. Stamping it before
    // `runInteractivePrompt` charges the harness launch itself against the
    // role's working time and burns the grace before `apnea wait` polls
    // even once — one flaky `herdr pane get` then kills a live role.
    const now = 1_700_000_000_000
    const interactiveDelayMs = 30_000 // well over the 12s liveness grace
    const state = await runDispatch(
      { kind: "plan" },
      {
        nowMs: now,
        herdr: {
          enabled: true,
          interactive: {
            pane_id: "pane-1",
            label: "apnea:planner:fake",
            reused: false,
            prompt_accepted: true,
            prompt_attempts: 1,
            last_status: "working",
          },
          interactiveDelayMs,
        },
      },
    )
    expect(state.pending_started_at).toBe(now + interactiveDelayMs)
    // Budget is the role's configured timeout in full — the launch delay
    // must not be deducted from it.
    expect(state.pending_deadline_ms! - state.pending_started_at!).toBe(
      1_500_000,
    )
  })
})

describe("dispatchWorkflow — brief resolution", () => {
  // The packageRoot fix only reaches NEW runs: `start` freezes the value into
  // state.json, so a run begun by a build with the wrong root keeps pointing
  // every brief at the repo's parent even after upgrading. The live root is
  // the repair path when the pinned one has no brief at all.
  itEffect(
    "falls forward to the live package root when the pinned one has no briefs",
    () => {
      const state = baseState({
        step: "planning",
        package_root: "/stale/parent/dir",
      })
      const fsFake = makeFakeFileSystem({
        [statePath(ROOT)]: `${JSON.stringify(state, null, 2)}\n`,
        // Briefs exist ONLY under the live root, never under the stale one.
        ...briefFiles("/live-pkg"),
      })
      const { layer } = layerOf(fsFake, { herdr: { enabled: false } })
      return Effect.gen(function* () {
        const r = yield* dispatchWorkflow({ kind: "plan" }, ROOT, {
          packageRoot: () => "/live-pkg",
        })
        expect(r.ok).toBe(true)
      }).pipe(Effect.provide(layer))
    },
  )

  // The repair must stay a repair. When BOTH roots hold a brief, the run's
  // pinned root wins: the live install can be a different apnea version whose
  // briefs describe a different artifact layout, and silently swapping
  // mid-run points the role at one protocol while the run's gates expect
  // another. A run keeps the briefs it started with.
  itEffect("prefers the run's pinned briefs when both roots have them", () => {
    const state = baseState({ step: "planning", package_root: "/pinned" })
    const fsFake = makeFakeFileSystem({
      [statePath(ROOT)]: `${JSON.stringify(state, null, 2)}\n`,
      ...briefFiles("/pinned"),
      ...briefFiles("/live-pkg"),
    })
    const { layer, fakeFs } = layerOf(fsFake, { herdr: { enabled: false } })
    return Effect.gen(function* () {
      const r = yield* dispatchWorkflow({ kind: "plan" }, ROOT, {
        packageRoot: () => "/live-pkg",
      })
      expect(r.ok).toBe(true)
      // The task file names the brief the role must read.
      const taskFile = [...fakeFs.files.keys()].find((k) =>
        k.includes("/.apnea/tasks/"),
      )!
      expect(fakeFs.files.get(taskFile)).toContain("/pinned/briefs/planner.md")
      expect(fakeFs.files.get(taskFile)).not.toContain("/live-pkg")
    }).pipe(Effect.provide(layer))
  })

  // A refusal must not mutate. The brief check originally ran AFTER
  // clear-before-dispatch, so refusing had already renamed the existing
  // artifact to a timestamped .bak — status and wait then saw no artifact,
  // and the content was recoverable only by finding the backup by hand.
  itEffect(
    "a missing-brief refusal leaves the existing artifact untouched",
    () => {
      const state = baseState({ step: "planning" })
      const planAbs = `${ROOT}/.apnea/artifacts/plan.md`
      const fsFake = makeFakeFileSystem({
        [statePath(ROOT)]: `${JSON.stringify(state, null, 2)}\n`,
        [planAbs]: "---\nstatus: done\n---\nprior plan\n",
        // deliberately no briefs anywhere
      })
      const { layer, fakeFs } = layerOf(fsFake, { herdr: { enabled: false } })
      return Effect.gen(function* () {
        const r = yield* Effect.result(
          dispatchWorkflow({ kind: "plan" }, ROOT, {
            packageRoot: () => "/live-pkg",
          }),
        )
        expectFailure(r, "GateRefused")
        expect(fakeFs.files.get(planAbs)).toContain("prior plan")
        expect(
          [...fakeFs.files.keys()].some((k) => k.includes("plan.md.bak.")),
        ).toBe(false)
      }).pipe(Effect.provide(layer))
    },
  )

  // A pane launched with a prompt pointing at a brief that is not there does
  // not fail: the role simply sits in the pane, and apnea reports a healthy
  // dispatch. Refuse before launching, and name what was tried — each
  // location ONCE. When the pinned and live roots are equal the candidate
  // list must collapse, or the message claims two locations were tried when
  // only one was.
  itEffect("refuses instead of launching, naming each tried path once", () => {
    const state = baseState({ step: "planning", package_root: "/pkg" })
    const fsFake = makeFakeFileSystem({
      [statePath(ROOT)]: `${JSON.stringify(state, null, 2)}\n`,
      // deliberately no briefs/
    })
    const { layer } = layerOf(fsFake, { herdr: { enabled: false } })
    return Effect.gen(function* () {
      const r = yield* Effect.result(
        dispatchWorkflow({ kind: "plan" }, ROOT, { packageRoot: () => "/pkg" }),
      )
      const e = expectFailure(r, "GateRefused")
      const msg = toToolResult(e).error!
      expect(msg).toContain("no brief for role")
      expect(msg.split("/pkg/briefs/planner.md").length - 1).toBe(1)
      expect(msg).not.toContain(" and ")
    }).pipe(Effect.provide(layer))
  })
})
