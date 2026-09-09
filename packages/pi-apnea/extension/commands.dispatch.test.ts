import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { OPERATIONS, type ExecuteOperation } from "@naxodev/apnea"
import { Effect, Layer } from "effect"
import { abs, statePath } from "../../apnea/extension/domain/paths.ts"
import type { RunState } from "../../apnea/extension/domain/types.ts"
import {
  RunStore,
  RunStoreLive,
} from "../../apnea/extension/services/run-store.ts"
import { expectFailure } from "../../apnea/extension/test/expect-failure.ts"
import { fakeConfigLayer } from "../../apnea/extension/test/fake-config.ts"
import { makeFakeFileSystem } from "../../apnea/extension/test/fake-file-system.ts"
import { fakeVcsLayer } from "../../apnea/extension/test/fake-vcs.ts"
import { commitWorkflow } from "../../apnea/extension/workflows/commit.ts"
import { registerApneaCommands } from "./commands.ts"

type Notify = (message: string, level?: "info" | "warning" | "error") => void
type Handler = (args: string, ctx: { ui: { notify: Notify } }) => Promise<void>

function captureApneaHandler(execute: ExecuteOperation): Handler {
  let captured: Handler | undefined
  const fakePi = {
    registerCommand: (name: string, options: { handler: Handler }) => {
      if (name === "apnea") captured = options.handler
    },
    sendUserMessage: () => {},
  }
  type ExtensionAPIArg = Parameters<typeof registerApneaCommands>[0]
  registerApneaCommands(
    fakePi as unknown as ExtensionAPIArg,
    OPERATIONS,
    execute,
  )
  if (!captured) throw new Error('"apnea" command was never registered')
  return captured
}

async function run(handler: Handler, args: string) {
  const notifications: Array<{ message: string; level?: string }> = []
  await handler(args, {
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
    },
  })
  return notifications
}

describe("registerApneaCommands registry parity", () => {
  test("bare commit recovers an interrupted final phase without overriding durable options", async () => {
    const root = resolve("/proj")
    const state = {
      version: 2,
      slug: "demo",
      step: "committing",
      phase_index: 1,
      phase_count_hint: null,
      rounds: {},
      vcs: "jj",
      allow_dirty: false,
      goal: "ship the final phase",
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
      package_root: resolve("/pkg"),
      reviewer_tree_fingerprint: null,
      current_phase_package:
        ".apnea/artifacts/phase-01/round-1/phase-package.md",
      current_code_review: ".apnea/artifacts/phase-01/round-1/code-review.md",
      required_rework: null,
      pending_commit: null,
    } satisfies RunState
    const fs = makeFakeFileSystem({
      [statePath(root)]: JSON.stringify(state),
      [abs(state.current_code_review, root)]:
        "---\nstatus: done\nverdict: APPROVED\n---\nlooks good\n",
      [abs(state.current_phase_package, root)]:
        "# Phase\n\n```sh\necho ok\n```\n",
    })
    const vcs = fakeVcsLayer({ crashAfterCommitOnce: true })
    const layer = Layer.mergeAll(
      Layer.provideMerge(RunStoreLive, fs.layer),
      fakeConfigLayer(),
      vcs.layer,
    )
    const execute: ExecuteOperation = async (verb, params) => {
      expect(verb).toBe("commit")
      return Effect.runPromise(
        commitWorkflow(params, root).pipe(Effect.provide(layer)),
      )
    }
    const handler = captureApneaHandler(execute)
    const load = () =>
      Effect.runPromise(
        Effect.flatMap(RunStore, (store) => store.require(root)).pipe(
          Effect.provide(layer),
        ),
      )

    const first = await run(handler, "commit release fix --done")
    expect(first.at(-1)?.level).toBe("error")
    expect(first.at(-1)?.message).toContain("simulated crash")
    const interrupted = await load()
    expect(interrupted.step).toBe("committing")
    if (!interrupted.pending_commit) {
      throw new Error("interrupted commit must persist its recovery options")
    }
    expect(interrupted.pending_commit?.no_remaining_phases).toBe(true)
    expect(interrupted.pending_commit?.message).toContain("release fix")
    expect(interrupted.pending_commit.verify_log).toBe(
      ".apnea/artifacts/phase-01/round-1/verify.log",
    )

    // Explicit false must remain a conflict, even though omission can recover.
    const conflict = await Effect.runPromise(
      Effect.result(commitWorkflow({ no_remaining_phases: false }, root)).pipe(
        Effect.provide(layer),
      ),
    )
    expect(expectFailure(conflict, "GateRefused").message).toContain(
      "conflicting retry",
    )
    expect(await load()).toEqual(interrupted)
    expect(vcs.recorder.completions).toHaveLength(1)

    const retry = await run(captureApneaHandler(execute), "commit")
    expect(retry.at(-1)?.level).toBe("info")
    expect(retry.at(-1)?.message).toContain("recovered transaction")
    const recovered = await load()
    expect(recovered.step).toBe("finishing")
    expect(recovered.phase_index).toBe(1)
    expect(recovered.pending_commit).toBeNull()
    expect(vcs.recorder.verifyRuns).toHaveLength(1)
    expect(vcs.recorder.prepares).toHaveLength(1)
    expect(vcs.recorder.completions).toHaveLength(2)
    expect(vcs.recorder.completions[1]?.pending).toEqual(
      interrupted.pending_commit,
    )
    expect(vcs.recorder.bookmarks).toEqual([{ root, slug: "demo" }])
  })

  test("every verb dispatches exact parameters from valid command input", async () => {
    const calls: Array<{ verb: string; params: Record<string, unknown> }> = []
    const execute: ExecuteOperation = async (verb, params) => {
      calls.push({ verb, params })
      return { ok: true, message: "stub" }
    }
    const handler = captureApneaHandler(execute)

    const fixtures = [
      {
        input:
          "abandon --confirm=state-token --stopped-work --acknowledge-corrupt",
        verb: "abandon",
        params: {
          confirm: "state-token",
          stopped_work: true,
          acknowledge_corrupt: true,
          stop_panes: undefined,
        },
      },
      {
        input: "setup --project --force --agents-md",
        verb: "setup",
        params: { project: true, force: true, agents_md: true },
      },
      {
        input: "start ship fix --allow-dirty --slug=ship-fix",
        verb: "start",
        params: {
          goal: "ship fix",
          slug: "ship-fix",
          allow_dirty: true,
          action: "start",
        },
      },
      {
        input: "dispatch plan --rework --redeliver",
        verb: "dispatch",
        params: { kind: "plan", rework: true, redeliver: true },
      },
      {
        input: "wait --poll=5000 --budget=20000",
        verb: "wait",
        params: { poll_ms: 5000, budget_ms: 20000 },
      },
      {
        input: "commit release fix --done",
        verb: "commit",
        params: { message: "release fix", no_remaining_phases: true },
      },
      { input: "status", verb: "status", params: {} },
      {
        input: "reset-rounds plan_review",
        verb: "reset-rounds",
        params: { gate: "plan_review" },
      },
    ] as const

    for (const fixture of fixtures) await run(handler, fixture.input)

    expect(calls).toEqual(
      fixtures.map(({ verb, params }) => ({ verb, params })),
    )
    expect(fixtures.map<string>(({ verb }) => verb).sort()).toEqual(
      OPERATIONS.map(({ verb }) => verb).sort(),
    )
  })

  test("resume and abandon route through distinct operations", async () => {
    const calls: Array<{ verb: string; params: Record<string, unknown> }> = []
    const handler = captureApneaHandler(async (verb, params) => {
      calls.push({ verb, params })
      return { ok: true, message: "stub" }
    })

    await run(handler, "resume")
    await run(handler, "abandon")

    expect(calls).toEqual([
      { verb: "start", params: { goal: "", action: "resume" } },
      {
        verb: "abandon",
        params: {
          confirm: undefined,
          stopped_work: undefined,
          acknowledge_corrupt: undefined,
          stop_panes: undefined,
        },
      },
    ])
  })

  test("Pi wait is unbounded because it has no host shell timeout", async () => {
    const calls: Array<{ verb: string; params: Record<string, unknown> }> = []
    const handler = captureApneaHandler(async (verb, params) => {
      calls.push({ verb, params })
      return { ok: true, message: "stub" }
    })

    await run(handler, "wait")

    expect(calls).toEqual([
      {
        verb: "wait",
        params: { poll_ms: undefined, budget_ms: Number.MAX_SAFE_INTEGER },
      },
    ])
  })

  test.each([
    "dispatch plan --rewrok",
    "wait --timeout 60000",
    "wait --budget",
    "wait --budget=",
    "status extra",
    "dispatch plan extra",
    "wait --budget=1000 --timeout=2000",
  ])("rejects invalid arguments without dispatching: %s", async (input) => {
    const calls: unknown[] = []
    const handler = captureApneaHandler(async (...args) => {
      calls.push(args)
      return { ok: true, message: "stub" }
    })

    const notifications = await run(handler, input)

    expect(calls).toEqual([])
    expect(notifications.at(-1)?.level).toBe("error")
  })

  test("supports literal goals beginning with -- after the terminator", async () => {
    const calls: Array<{ verb: string; params: Record<string, unknown> }> = []
    const handler = captureApneaHandler(async (verb, params) => {
      calls.push({ verb, params })
      return { ok: true, message: "stub" }
    })

    await run(handler, "start -- --ship safely")

    expect(calls).toEqual([
      {
        verb: "start",
        params: {
          goal: "--ship safely",
          slug: undefined,
          allow_dirty: false,
          action: "start",
        },
      },
    ])
  })
})
