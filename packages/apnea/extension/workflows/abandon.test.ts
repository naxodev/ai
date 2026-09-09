import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { packageRoot, statePath } from "../domain/paths.ts"
import { HerdrError } from "../errors.ts"
import type { PendingCommit } from "../domain/types.ts"
import { RunStore, RunStoreLive } from "../services/run-store.ts"
import { Herdr } from "../services/herdr.ts"
import { briefFiles } from "../test/briefs.ts"
import { expectFailure } from "../test/expect-failure.ts"
import { fakeConfigLayer } from "../test/fake-config.ts"
import { makeFakeFileSystem } from "../test/fake-file-system.ts"
import { fakeHerdrLayer } from "../test/fake-herdr.ts"
import { fakeVcsLayer } from "../test/fake-vcs.ts"
import { itEffect } from "../test/it-effect.ts"
import { abandonWorkflow } from "./abandon.ts"
import { dispatchWorkflow } from "./dispatch.ts"
import { startWorkflow } from "./start.ts"
import { waitWorkflow } from "./wait.ts"

const root = "/proj"
function harness(
  options: {
    corrupt?: string
    failArchive?: boolean
    closeFailure?: boolean
  } = {},
) {
  const fs = makeFakeFileSystem(
    {
      ...briefFiles(packageRoot()),
      ...(options.corrupt === undefined
        ? {}
        : { [statePath(root)]: options.corrupt }),
    },
    {
      failWrite: (p) =>
        options.failArchive &&
        p.includes(".abandoned.") &&
        !p.endsWith(".audit.json")
          ? new Error("archive disk failure")
          : null,
    },
  )
  const herdr = fakeHerdrLayer({
    enabled: false,
    ...(options.closeFailure
      ? { failPaneClose: new HerdrError({ message: "pane stop failed" }) }
      : {}),
  })
  const layer = Layer.mergeAll(
    Layer.provideMerge(RunStoreLive, fs.layer),
    fakeConfigLayer(),
    fakeVcsLayer({ detect: "jj" }).layer,
    herdr.layer,
    TestClock.layer(),
  )
  return { fs, herdr, layer }
}
const previewToken = Effect.fn("test.previewToken")(function* () {
  const result = yield* abandonWorkflow({}, root)
  if (!result.ok || typeof result.data?.confirmation !== "string")
    throw new Error("preview omitted token")
  return result.data.confirmation
})

describe("human abandon recovery", () => {
  itEffect(
    "interrupted close leaves intent evidence and state for an explicit retry",
    () => {
      const t = harness()
      return Effect.gen(function* () {
        yield* startWorkflow({ goal: "cancel close" }, root)
        const store = yield* RunStore
        const state = yield* store.require(root)
        state.acquired_panes = [{ pane_id: "owned", label: "worker" }]
        yield* store.save(state, root)
        const before = t.fs.files.get(statePath(root))
        const confirm = yield* previewToken()
        const herdr = yield* Herdr
        const fiber = yield* Effect.forkChild(
          abandonWorkflow({ confirm, stop_panes: true }, root).pipe(
            Effect.provideService(Herdr, {
              ...herdr,
              requestPaneClose: () => Effect.interrupt,
            }),
          ),
        )
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
        expect(t.fs.files.get(statePath(root))).toBe(before)
        expect(
          [...t.fs.files.keys()].some((p) => p.includes(".stop-attempt.")),
        ).toBe(true)
        yield* abandonWorkflow({ confirm, stopped_work: true }, root)
        expect(t.fs.files.has(statePath(root))).toBe(false)
      }).pipe(Effect.provide(t.layer))
    },
  )
  itEffect(
    "manual work requires attestation; late old output cannot satisfy the new run",
    () => {
      const t = harness()
      return Effect.gen(function* () {
        const store = yield* RunStore
        yield* startWorkflow({ goal: "same goal" }, root)
        yield* dispatchWorkflow({ kind: "plan" }, root)
        const old = yield* store.require(root)
        const oldRaw = t.fs.files.get(statePath(root))
        const oldTask = [...t.fs.files.keys()].find((p) =>
          p.includes("/tasks/"),
        )
        expect(old.pending_delivery).toBe("manual")
        const confirm = yield* previewToken()
        expectFailure(
          yield* Effect.result(abandonWorkflow({ confirm }, root)),
          "GateRefused",
        )
        expect(t.fs.files.get(statePath(root))).toBe(oldRaw)
        const abandoned = yield* abandonWorkflow(
          { confirm, stopped_work: true },
          root,
        )
        if (!abandoned.ok) throw new Error("abandon refused")
        expect(t.fs.files.get(String(abandoned.data?.backup))).toBe(oldRaw)
        expect(t.fs.files.has(String(abandoned.data?.audit))).toBe(true)
        expect(t.fs.files.has(oldTask ?? "missing task")).toBe(true)
        yield* startWorkflow({ goal: "same goal" }, root)
        yield* dispatchWorkflow({ kind: "plan" }, root)
        const fresh = yield* store.require(root)
        expect(fresh.run_id).not.toBe(old.run_id)
        expect(fresh.pending_artifact).not.toBe(old.pending_artifact)
        expect(fresh.pending_artifact).toContain(`/runs/${fresh.run_id}/`)
        // Simulate a mistaken human attestation: the old worker writes late.
        t.fs.files.set(
          `${root}/${old.pending_artifact}`,
          "---\nstatus: done\n---\nold output",
        )
        const waiting = yield* Effect.forkChild(
          waitWorkflow({ poll_ms: 1000, budget_ms: 90000 }, root),
        )
        yield* TestClock.adjust(90000)
        const result = yield* Fiber.join(waiting)
        expect(result.ok && result.data?.pending).toBe(true)
        expect((yield* store.require(root)).step).toBe("planning")
        // Artifact-only completion still works for this run's own path.
        t.fs.files.set(
          `${root}/${fresh.pending_artifact}`,
          "---\nstatus: done\n---\nnew output",
        )
        yield* waitWorkflow({}, root)
        expect((yield* store.require(root)).step).toBe("plan_review")
        expect(t.fs.files.get(`${root}/${old.pending_artifact}`)).toContain(
          "old output",
        )
      }).pipe(Effect.provide(t.layer))
    },
  )

  itEffect(
    "preview exposes the full commit transaction and cannot discard its recovery",
    () => {
      const t = harness()
      return Effect.gen(function* () {
        yield* startWorkflow({ goal: "commit" }, root)
        const store = yield* RunStore
        const state = yield* store.require(root)
        const commit: PendingCommit = {
          backend: "jj",
          id: "txn",
          phase_index: 1,
          message: "commit",
          no_remaining_phases: false,
          verify_log: ".apnea/artifacts/verify.log",
          change_id: "abc",
          content_fingerprint: "abcdef12",
        }
        state.step = "committing"
        state.pending_commit = commit
        state.pending_role = "coder"
        state.pending_pane_id = "owned-pane"
        state.pending_artifact = ".apnea/artifacts/coder-result.md"
        yield* store.save(state, root)
        const before = t.fs.files.get(statePath(root))
        const preview = yield* abandonWorkflow({}, root)
        expect(preview.ok && preview.data?.pending_commit).toEqual(commit)
        expect(preview.ok && preview.data?.pending_pane_id).toBe("owned-pane")
        const confirm = yield* previewToken()
        const error = expectFailure(
          yield* Effect.result(
            abandonWorkflow(
              {
                confirm,
                stopped_work: true,
                acknowledge_corrupt: true,
                stop_panes: true,
              },
              root,
            ),
          ),
          "GateRefused",
        )
        expect(error.message).toContain("Unresolved durable commit")
        expect(t.fs.files.get(statePath(root))).toBe(before)
        expect(t.herdr.recorder.paneCloses).toEqual([])
      }).pipe(Effect.provide(t.layer))
    },
  )

  for (const closeFailure of [false, true])
    itEffect(
      `pane close ${closeFailure ? "failure" : "success"} retains state until explicit termination attestation`,
      () => {
        const t = harness({ closeFailure })
        return Effect.gen(function* () {
          yield* startWorkflow({ goal: "owned panes" }, root)
          const store = yield* RunStore
          const state = yield* store.require(root)
          state.acquired_panes = [
            { pane_id: "replaced", label: "old" },
            { pane_id: "latest", label: "new" },
          ]
          yield* store.save(state, root)
          const before = t.fs.files.get(statePath(root))
          const confirm = yield* previewToken()
          const error = expectFailure(
            yield* Effect.result(
              abandonWorkflow(
                { confirm, stop_panes: true, stopped_work: true },
                root,
              ),
            ),
            "GateRefused",
          )
          expect(error.message).toContain("Termination remains unproven")
          expect(t.herdr.recorder.paneCloses).toEqual(["replaced", "latest"])
          expect(t.fs.files.get(statePath(root))).toBe(before)
          expect(
            [...t.fs.files.keys()].some((p) => p.includes(".stop-attempt.")),
          ).toBe(true)
          yield* abandonWorkflow({ confirm, stopped_work: true }, root)
          expect(t.fs.files.has(statePath(root))).toBe(false)
        }).pipe(Effect.provide(t.layer))
      },
    )

  itEffect(
    "corrupt escape requires both acknowledgments and binds them to raw state",
    () => {
      const t = harness({ corrupt: "{broken\n" })
      return Effect.gen(function* () {
        const confirm = yield* previewToken()
        expectFailure(
          yield* Effect.result(
            abandonWorkflow({ confirm, stopped_work: true }, root),
          ),
          "GateRefused",
        )
        expectFailure(
          yield* Effect.result(
            abandonWorkflow({ confirm, acknowledge_corrupt: true }, root),
          ),
          "GateRefused",
        )
        t.fs.files.set(statePath(root), "{changed\n")
        expectFailure(
          yield* Effect.result(
            abandonWorkflow(
              { confirm, stopped_work: true, acknowledge_corrupt: true },
              root,
            ),
          ),
          "GateRefused",
        )
        const result = yield* abandonWorkflow(
          {
            confirm: yield* previewToken(),
            stopped_work: true,
            acknowledge_corrupt: true,
          },
          root,
        )
        expect(result.ok && t.fs.files.get(String(result.data?.backup))).toBe(
          "{changed\n",
        )
      }).pipe(Effect.provide(t.layer))
    },
  )

  itEffect(
    "archive failure retains active state and audit so retry cannot permit restart",
    () => {
      const t = harness({ corrupt: "{broken", failArchive: true })
      return Effect.gen(function* () {
        const confirm = yield* previewToken()
        expectFailure(
          yield* Effect.result(
            abandonWorkflow(
              { confirm, stopped_work: true, acknowledge_corrupt: true },
              root,
            ),
          ),
          "ConfigError",
        )
        expect(t.fs.files.get(statePath(root))).toBe("{broken")
        expect(
          [...t.fs.files.keys()].some((p) => p.endsWith(".audit.json")),
        ).toBe(true)
        expectFailure(
          yield* Effect.result(startWorkflow({ goal: "restart" }, root)),
          "StateCorrupt",
        )
      }).pipe(Effect.provide(t.layer))
    },
  )
})
