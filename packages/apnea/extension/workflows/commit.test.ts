import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { statePath } from "../domain/paths.ts"
import type { RunState } from "../domain/types.ts"
import { expectFailure } from "../test/expect-failure.ts"
import { fakeConfigLayer } from "../test/fake-config.ts"
import { makeFakeFileSystem } from "../test/fake-file-system.ts"
import { fakeVcsLayer } from "../test/fake-vcs.ts"
import { itEffect } from "../test/it-effect.ts"
import { RunStore, RunStoreLive } from "../services/run-store.ts"
import { PERSISTED_INPUT_MAX_BYTES } from "../services/file-system.ts"
import { commitWorkflow } from "./commit.ts"

const ROOT = "/proj"

function baseState(over: Partial<RunState> = {}): RunState {
  return {
    version: 2,
    slug: "demo",
    step: "committing",
    phase_index: 1,
    phase_count_hint: null,
    rounds: {},
    vcs: "jj",
    allow_dirty: false,
    goal: "g",
    last_error: null,
    pending_artifact: null,
    pending_role: null,
    pending_delivery: null,
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
    current_phase_package: ".apnea/artifacts/phase-01/round-1/phase-package.md",
    current_code_review: ".apnea/artifacts/phase-01/round-1/code-review.md",
    required_rework: null,
    pending_commit: null,
    ...over,
  }
}

function approvedReview(): string {
  return "---\nstatus: done\nverdict: APPROVED\n---\nlooks good\n"
}

function changesRequiredReview(): string {
  return "---\nstatus: done\nverdict: CHANGES_REQUIRED\n---\nfix it\n"
}

function phasePackage(cmds = "echo ok"): string {
  return `# Phase\n\n\`\`\`sh\n${cmds}\n\`\`\`\n`
}

function seedFiles(state: RunState, files: Record<string, string> = {}) {
  const initial: Record<string, string> = {
    [statePath(ROOT)]: `${JSON.stringify(state, null, 2)}\n`,
    ...files,
  }
  return makeFakeFileSystem(initial)
}

function layerOf(
  fakeFs: ReturnType<typeof makeFakeFileSystem>,
  vcsOpts: Parameters<typeof fakeVcsLayer>[0] = {},
  cfgOpts: Parameters<typeof fakeConfigLayer>[0] = {},
) {
  const vcs = fakeVcsLayer(vcsOpts)
  const cfg = fakeConfigLayer(cfgOpts)
  const layer = Layer.mergeAll(
    Layer.provideMerge(RunStoreLive, fakeFs.layer),
    cfg,
    vcs.layer,
  )
  return { layer, vcs: vcs.recorder, fakeFs }
}

describe("commitWorkflow (fake layers)", () => {
  itEffect("wrong step → IllegalTool", () => {
    const state = baseState({ step: "planning" })
    const fs = seedFiles(state)
    const { layer } = layerOf(fs)
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(commitWorkflow({}, ROOT))
      expect(Exit.isFailure(exit)).toBe(true)
      const r = yield* Effect.result(commitWorkflow({}, ROOT))
      expectFailure(r, "IllegalTool")
    }).pipe(Effect.provide(layer))
  })

  itEffect("missing current_code_review → GateRefused", () => {
    const state = baseState({ current_code_review: null })
    const fs = seedFiles(state)
    const { layer } = layerOf(fs)
    return Effect.gen(function* () {
      const r = yield* Effect.result(commitWorkflow({}, ROOT))
      const e = expectFailure(r, "GateRefused")
      expect(e.message).toContain("current_code_review not set")
    }).pipe(Effect.provide(layer))
  })

  itEffect("verdict CHANGES_REQUIRED → GateRefused with details.review", () => {
    const state = baseState()
    const reviewAbs = `${ROOT}/${state.current_code_review}`
    const pkgAbs = `${ROOT}/${state.current_phase_package}`
    const fs = seedFiles(state, {
      [reviewAbs]: changesRequiredReview(),
      [pkgAbs]: phasePackage(),
    })
    const { layer } = layerOf(fs)
    return Effect.gen(function* () {
      const r = yield* Effect.result(commitWorkflow({}, ROOT))
      const e = expectFailure(r, "GateRefused")
      expect(e.details?.review).toBe(state.current_code_review)
      expect(e.details?.verdict).toBe("CHANGES_REQUIRED")
    }).pipe(Effect.provide(layer))
  })

  itEffect("package without sh block → ArtifactInvalid", () => {
    const state = baseState()
    const reviewAbs = `${ROOT}/${state.current_code_review}`
    const pkgAbs = `${ROOT}/${state.current_phase_package}`
    const fs = seedFiles(state, {
      [reviewAbs]: approvedReview(),
      [pkgAbs]: "# no verify block\n",
    })
    const { layer } = layerOf(fs)
    return Effect.gen(function* () {
      const r = yield* Effect.result(commitWorkflow({}, ROOT))
      const e = expectFailure(r, "ArtifactInvalid")
      expect(e.message).toContain("no verify commands")
    }).pipe(Effect.provide(layer))
  })

  itEffect("oversized review fails as ArtifactInvalid", () => {
    const state = baseState()
    const reviewAbs = `${ROOT}/${state.current_code_review}`
    const fs = seedFiles(state, {
      [reviewAbs]: "x".repeat(PERSISTED_INPUT_MAX_BYTES + 1),
    })
    const { layer } = layerOf(fs)
    return Effect.gen(function* () {
      const result = yield* Effect.result(commitWorkflow({}, ROOT))
      const error = expectFailure(result, "ArtifactInvalid")
      expect(error.artifact).toBe(state.current_code_review!)
      expect(error.message).toContain("byte limit")
    }).pipe(Effect.provide(layer))
  })

  itEffect("oversized phase package fails as ArtifactInvalid", () => {
    const state = baseState()
    const reviewAbs = `${ROOT}/${state.current_code_review}`
    const pkgAbs = `${ROOT}/${state.current_phase_package}`
    const fs = seedFiles(state, {
      [reviewAbs]: approvedReview(),
      [pkgAbs]: "x".repeat(PERSISTED_INPUT_MAX_BYTES + 1),
    })
    const { layer } = layerOf(fs)
    return Effect.gen(function* () {
      const result = yield* Effect.result(commitWorkflow({}, ROOT))
      const error = expectFailure(result, "ArtifactInvalid")
      expect(error.artifact).toBe(state.current_phase_package!)
      expect(error.message).toContain("byte limit")
    }).pipe(Effect.provide(layer))
  })

  itEffect(
    "comment-only verify fence → ArtifactInvalid without verification",
    () => {
      const state = baseState()
      const reviewAbs = `${ROOT}/${state.current_code_review}`
      const pkgAbs = `${ROOT}/${state.current_phase_package}`
      const fs = seedFiles(state, {
        [reviewAbs]: approvedReview(),
        [pkgAbs]: phasePackage("# no executable check"),
      })
      const { layer, vcs } = layerOf(fs)
      return Effect.gen(function* () {
        const r = yield* Effect.result(commitWorkflow({}, ROOT))
        expectFailure(r, "ArtifactInvalid")
        expect(vcs.verifyRuns).toHaveLength(0)
        expect(vcs.prepares).toHaveLength(0)
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "non-shell example fence without a Verify heading is never executed",
    () => {
      const state = baseState()
      const reviewAbs = `${ROOT}/${state.current_code_review}`
      const pkgAbs = `${ROOT}/${state.current_phase_package}`
      const fs = seedFiles(state, {
        [reviewAbs]: approvedReview(),
        [pkgAbs]: "```typescript\nconst command = 'bun test'\n```\n",
      })
      const { layer, vcs } = layerOf(fs)
      return Effect.gen(function* () {
        const r = yield* Effect.result(commitWorkflow({}, ROOT))
        expectFailure(r, "ArtifactInvalid")
        expect(vcs.verifyRuns).toHaveLength(0)
        expect(vcs.prepares).toHaveLength(0)
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "verify failure → VerifyFailed + verify.log written + state unchanged",
    () => {
      const state = baseState()
      const reviewAbs = `${ROOT}/${state.current_code_review}`
      const pkgAbs = `${ROOT}/${state.current_phase_package}`
      const fs = seedFiles(state, {
        [reviewAbs]: approvedReview(),
        [pkgAbs]: `# Phase

## Verify commands

\`\`\`sh
echo first
\`\`\`

\`\`\`bash
false
echo unreachable
\`\`\`
`,
      })
      const { layer, vcs, fakeFs } = layerOf(fs, {
        // failing verify (tagged VerifyFailed path — not a ToolResult)
        verify: { ok: Boolean(0), log: "$ false\nexit=1" },
      })
      return Effect.gen(function* () {
        const r = yield* Effect.result(commitWorkflow({}, ROOT))
        const e = expectFailure(r, "VerifyFailed")
        expect(vcs.verifyRuns[0]?.blocks).toEqual([
          { interpreter: "sh", source: "echo first\n" },
          { interpreter: "bash", source: "false\necho unreachable\n" },
        ])
        expect(e.commands).toEqual([
          "sh -e -c 'echo first\n'",
          "bash -e -c 'false\necho unreachable\n'",
        ])
        expect(e.outputs[0]).toContain("exit=1")
        // outputs is only the last 2000 chars — a real tsc/test failure
        // overflows it, so the caller must be told where the full log is.
        expect(e.verify_log).toBe(
          ".apnea/artifacts/phase-01/round-1/verify.log",
        )
        // verify.log next to review
        const vlog = `${ROOT}/.apnea/artifacts/phase-01/round-1/verify.log`
        expect(fakeFs.files.has(vlog)).toBe(true)
        expect(fakeFs.files.get(vlog)).toContain("exit=1")
        // no commit recorded
        expect(vcs.prepares.length).toBe(0)
        // state unchanged
        const store = yield* RunStore
        const after = yield* store.require(ROOT)
        expect(after.step).toBe("committing")
        expect(after.phase_index).toBe(1)
        expect(after.current_code_review).toBe(state.current_code_review)
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect("verify success → commit recorded, state advances", () => {
    const state = baseState()
    const reviewAbs = `${ROOT}/${state.current_code_review}`
    const pkgAbs = `${ROOT}/${state.current_phase_package}`
    const fs = seedFiles(state, {
      [reviewAbs]: approvedReview(),
      [pkgAbs]: phasePackage(),
    })
    const { layer, vcs } = layerOf(fs, {
      verify: { ok: true, log: "$ echo ok\nexit=0\n" },
    })
    return Effect.gen(function* () {
      const result = yield* commitWorkflow({}, ROOT)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data?.step).toBe("phase_packaging")
        expect(result.data?.phase_index).toBe(2)
        expect(result.data?.transaction).toBe("fake-jj-transaction-id")
        expect(String(result.data?.vcs_detail)).toContain("jj commit")
        expect(result.data?.verify_log).toContain("verify.log")
      }
      // The durable transaction is cleared only after completion.
      expect(vcs.prepares).toHaveLength(1)
      expect(vcs.completions).toHaveLength(1)
      const store = yield* RunStore
      const after = yield* store.require(ROOT)
      expect(after.step).toBe("phase_packaging")
      expect(after.phase_index).toBe(2)
      expect(after.current_phase_package).toBeNull()
      expect(after.current_code_review).toBeNull()
      expect(after.pending_commit).toBeNull()
    }).pipe(Effect.provide(layer))
  })

  itEffect(
    "durable point: pending_commit saved before completion, cleared after",
    () => {
      const state = baseState({ vcs: "git" })
      const reviewAbs = `${ROOT}/${state.current_code_review}`
      const pkgAbs = `${ROOT}/${state.current_phase_package}`
      const fs = seedFiles(state, {
        [reviewAbs]: approvedReview(),
        [pkgAbs]: phasePackage(),
      })
      const { layer, vcs, fakeFs } = layerOf(fs, {
        verify: { ok: true, log: "$ echo ok\nexit=0\n" },
        failComplete: "simulated crash during completion",
      })
      return Effect.gen(function* () {
        const r = yield* Effect.result(commitWorkflow({}, ROOT))
        expectFailure(r, "VcsError")
        // prepare ran and the anchor was persisted before the failure.
        expect(vcs.prepares).toHaveLength(1)
        const persisted = JSON.parse(fakeFs.files.get(statePath(ROOT))!) as {
          pending_commit: { backend: string } | null
        }
        expect(persisted.pending_commit?.backend).toBe("git")
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "crash between prepare-save and completion resumes without double commit",
    () => {
      const state = baseState()
      const reviewAbs = `${ROOT}/${state.current_code_review}`
      const pkgAbs = `${ROOT}/${state.current_phase_package}`
      const fs = seedFiles(state, {
        [reviewAbs]: approvedReview(),
        [pkgAbs]: phasePackage(),
      })
      const { layer, vcs } = layerOf(fs, {
        verify: { ok: true, log: "$ echo ok\nexit=0\n" },
        crashAfterCommitOnce: true,
      })
      return Effect.gen(function* () {
        // First call "crashes" after the VCS-level commit happened but
        // before recognition. The durable anchor must remain.
        const first = yield* Effect.result(commitWorkflow({}, ROOT))
        expectFailure(first, "VcsError")
        const store = yield* RunStore
        const mid = yield* store.require(ROOT)
        expect(mid.step).toBe("committing")
        expect(mid.pending_commit?.id).toBe("fake-jj-transaction-id")

        // Resume: gates and verification are skipped entirely, completion
        // recognizes the landed commit, and the run advances exactly once.
        const second = yield* commitWorkflow({}, ROOT)
        expect(second.ok).toBe(true)
        if (second.ok) {
          expect(second.message).toContain("recovered transaction")
          expect(second.data?.step).toBe("phase_packaging")
        }
        expect(vcs.verifyRuns).toHaveLength(1)
        expect(vcs.completions).toHaveLength(2)
        const after = yield* store.require(ROOT)
        expect(after.step).toBe("phase_packaging")
        expect(after.phase_index).toBe(2)
        expect(after.pending_commit).toBeNull()
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect(
    "resume skips gates and verification even with missing artifacts",
    () => {
      const state = baseState({
        current_code_review: null,
        current_phase_package: null,
        pending_commit: {
          id: "fake-jj-transaction-id",
          backend: "jj",
          phase_index: 1,
          message:
            "feat: apnea phase 1 (demo)\n\nApnea-Transaction: fake-jj-transaction-id",
          no_remaining_phases: false,
          verify_log: ".apnea/artifacts/phase-01/round-1/verify.log",
          change_id: "change0000",
          content_fingerprint: "f00dcafe0000",
        },
      })
      const fs = seedFiles(state)
      const { layer, vcs } = layerOf(fs)
      return Effect.gen(function* () {
        const result = yield* commitWorkflow({}, ROOT)
        expect(result.ok).toBe(true)
        expect(vcs.verifyRuns).toHaveLength(0)
        expect(vcs.completions).toHaveLength(1)
        expect(vcs.prepares).toHaveLength(0)
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect("resume refuses a conflicting message param", () => {
    const state = baseState({
      pending_commit: {
        id: "fake-jj-transaction-id",
        backend: "jj",
        phase_index: 1,
        message:
          "feat: apnea phase 1 (demo)\n\nApnea-Transaction: fake-jj-transaction-id",
        no_remaining_phases: false,
        verify_log: ".apnea/artifacts/phase-01/round-1/verify.log",
        change_id: "change0000",
        content_fingerprint: "f00dcafe0000",
      },
    })
    const fs = seedFiles(state)
    const { layer, vcs } = layerOf(fs)
    return Effect.gen(function* () {
      const r = yield* Effect.result(
        commitWorkflow({ message: "a different message" }, ROOT),
      )
      const e = expectFailure(r, "GateRefused")
      expect(e.message).toContain("conflicting retry")
      expect(e.details?.transaction).toBe("fake-jj-transaction-id")
      // The original message (without trailer) is accepted.
      const okResult = yield* commitWorkflow(
        { message: "feat: apnea phase 1 (demo)" },
        ROOT,
      )
      expect(okResult.ok).toBe(true)
      expect(vcs.completions).toHaveLength(1)
    }).pipe(Effect.provide(layer))
  })

  ;(itEffect(
    "resume accepts a plain retry whose message itself ends with a trailer-shaped line",
    () => {
      // The user's message legitimately ends with a trailer-shaped line, so
      // the persisted message carries two. Stripping only the LAST trailer
      // would leave the fake one and refuse an identical retry.
      const userMessage =
        "feat: apnea phase 1 (demo)\n\nApnea-Transaction: not-a-real-id"
      const state = baseState({
        pending_commit: {
          id: "fake-jj-transaction-id",
          backend: "jj",
          phase_index: 1,
          message:
            "feat: apnea phase 1 (demo)\n\nApnea-Transaction: not-a-real-id\n\nApnea-Transaction: fake-jj-transaction-id",
          no_remaining_phases: false,
          verify_log: ".apnea/artifacts/phase-01/round-1/verify.log",
          change_id: "change0000",
          content_fingerprint: "f00dcafe0000",
        },
      })
      const fs = seedFiles(state)
      const { layer } = layerOf(fs)
      return Effect.gen(function* () {
        const r = yield* commitWorkflow({ message: userMessage }, ROOT)
        expect(r.ok).toBe(true)
      }).pipe(Effect.provide(layer))
    },
  ),
    itEffect("resume refuses a conflicting no_remaining_phases param", () => {
      const state = baseState({
        pending_commit: {
          id: "fake-jj-transaction-id",
          backend: "jj",
          phase_index: 1,
          message:
            "feat: apnea phase 1 (demo)\n\nApnea-Transaction: fake-jj-transaction-id",
          no_remaining_phases: false,
          verify_log: ".apnea/artifacts/phase-01/round-1/verify.log",
          change_id: "change0000",
          content_fingerprint: "f00dcafe0000",
        },
      })
      const fs = seedFiles(state)
      const { layer } = layerOf(fs)
      return Effect.gen(function* () {
        const r = yield* Effect.result(
          commitWorkflow({ no_remaining_phases: true }, ROOT),
        )
        const e = expectFailure(r, "GateRefused")
        expect(e.message).toContain("no_remaining_phases")
      }).pipe(Effect.provide(layer))
    }))

  itEffect(
    "bookmark failure leaves the transaction resumable, not advanced",
    () => {
      const state = baseState()
      const reviewAbs = `${ROOT}/${state.current_code_review}`
      const pkgAbs = `${ROOT}/${state.current_phase_package}`
      const fs = seedFiles(state, {
        [reviewAbs]: approvedReview(),
        [pkgAbs]: phasePackage(),
      })
      const { layer, vcs } = layerOf(fs, {
        failBookmark: "bookmark target moved",
      })
      return Effect.gen(function* () {
        const first = yield* Effect.result(
          commitWorkflow({ no_remaining_phases: true }, ROOT),
        )
        expectFailure(first, "VcsError")
        const store = yield* RunStore
        const mid = yield* store.require(ROOT)
        expect(mid.step).toBe("committing")
        expect(mid.pending_commit).not.toBeNull()

        // Retry without the failing bookmark completes and advances once.
        const retryVcs = fakeVcsLayer()
        const retryLayer = Layer.mergeAll(
          Layer.provideMerge(RunStoreLive, fs.layer),
          fakeConfigLayer({}),
          retryVcs.layer,
        )
        const recovered = yield* commitWorkflow(
          { no_remaining_phases: true },
          ROOT,
        ).pipe(Effect.provide(retryLayer))
        expect(recovered.ok).toBe(true)
        if (recovered.ok) expect(recovered.data?.step).toBe("finishing")
        expect(retryVcs.recorder.bookmarks).toEqual([
          { root: ROOT, slug: "demo" },
        ])
        const after = yield* store.require(ROOT)
        expect(after.pending_commit).toBeNull()
        expect(after.step).toBe("finishing")
      }).pipe(Effect.provide(layer))
    },
  )

  itEffect("no_remaining_phases on jj → finishing + bookmark recorded", () => {
    const state = baseState({ vcs: "jj" })
    const reviewAbs = `${ROOT}/${state.current_code_review}`
    const pkgAbs = `${ROOT}/${state.current_phase_package}`
    const fs = seedFiles(state, {
      [reviewAbs]: approvedReview(),
      [pkgAbs]: phasePackage(),
    })
    const { layer, vcs } = layerOf(fs)
    return Effect.gen(function* () {
      const result = yield* commitWorkflow({ no_remaining_phases: true }, ROOT)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data?.step).toBe("finishing")
        expect(result.data?.next).toEqual(["dispatch_role kind=pr_description"])
      }
      expect(vcs.bookmarks).toEqual([{ root: ROOT, slug: "demo" }])
    }).pipe(Effect.provide(layer))
  })

  itEffect("no_remaining_phases on git → finishing, no bookmark", () => {
    const state = baseState({ vcs: "git" })
    const reviewAbs = `${ROOT}/${state.current_code_review}`
    const pkgAbs = `${ROOT}/${state.current_phase_package}`
    const fs = seedFiles(state, {
      [reviewAbs]: approvedReview(),
      [pkgAbs]: phasePackage(),
    })
    const { layer, vcs } = layerOf(fs)
    return Effect.gen(function* () {
      const result = yield* commitWorkflow({ no_remaining_phases: true }, ROOT)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data?.step).toBe("finishing")
        expect(String(result.data?.vcs_detail)).toContain("git commit")
      }
      expect(vcs.bookmarks.length).toBe(0)
    }).pipe(Effect.provide(layer))
  })
})
