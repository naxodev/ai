import { Effect, Layer } from "effect"
import { VcsError } from "../errors.ts"
import type {
  GitPendingCommit,
  JjPendingCommit,
  PendingCommit,
  VcsBackend,
} from "../domain/types.ts"
import type { VerifyBlock } from "../domain/verify-commands.ts"
import { Vcs, type PreparedCommit, type VcsService } from "../services/vcs.ts"

export type FakeVcsOptions = {
  detect?: VcsBackend | null
  dirty?: boolean
  fingerprint?: string
  verify?: { ok: boolean; log: string }
  /** Detail returned by completeCommit (defaults to "<backend> commit fake"). */
  commitDetail?: string
  failPrepare?: VcsError | string
  /**
   * Simulate a crash after the VCS-level commit happened but before it was
   * recognized: the first completeCommit call records a completion, then
   * fails; later calls recognize and succeed.
   */
  crashAfterCommitOnce?: boolean
  failComplete?: VcsError | string
  failBookmark?: VcsError | string
  failEnsureBranch?: VcsError | string
  ensureBranch?: string
  /** Overrides merged into the prepared git anchor. */
  gitAnchor?: Partial<Omit<GitPendingCommit, "backend" | "id" | "message">>
  /** Overrides merged into the prepared jj anchor. */
  jjAnchor?: Partial<Omit<JjPendingCommit, "backend" | "id" | "message">>
}

export type FakeVcsRecorder = {
  prepares: Array<{ root: string; vcs: VcsBackend; message: string }>
  completions: Array<{ root: string; vcs: VcsBackend; pending: PendingCommit }>
  bookmarks: Array<{ root: string; slug: string }>
  verifyRuns: Array<{
    root: string
    blocks: readonly VerifyBlock[]
    timeoutMs: number
  }>
  ensureBranches: Array<{ root: string; slug: string }>
  detectCalls: string[]
  dirtyCalls: Array<{ root: string; vcs: VcsBackend }>
}

function toError(value: VcsError | string): VcsError {
  return typeof value === "string" ? new VcsError({ message: value }) : value
}

/** Scriptable Vcs layer that records calls for assertions. */
export function fakeVcsLayer(opts: FakeVcsOptions = {}): {
  layer: Layer.Layer<Vcs>
  recorder: FakeVcsRecorder
} {
  const recorder: FakeVcsRecorder = {
    prepares: [],
    completions: [],
    bookmarks: [],
    verifyRuns: [],
    ensureBranches: [],
    detectCalls: [],
    dirtyCalls: [],
  }
  let crashedAfterCommit = false

  const service: VcsService = {
    detect: (root) =>
      Effect.sync(() => {
        recorder.detectCalls.push(root)
        return opts.detect === undefined ? "jj" : opts.detect
      }),

    isDirty: (root, vcs) =>
      Effect.sync(() => {
        recorder.dirtyCalls.push({ root, vcs })
        return opts.dirty ?? false
      }),

    treeFingerprint: (_root, _vcs) =>
      Effect.succeed(opts.fingerprint ?? (opts.dirty ? "M src/x.ts" : "")),

    ensureGitBranch: (root, slug) =>
      Effect.gen(function* () {
        recorder.ensureBranches.push({ root, slug })
        if (opts.failEnsureBranch) {
          return yield* toError(opts.failEnsureBranch)
        }
        return opts.ensureBranch ?? `apnea/${slug}`
      }),

    prepareCommit: (root, vcs, message) =>
      Effect.gen(function* () {
        recorder.prepares.push({ root, vcs, message })
        if (opts.failPrepare) {
          return yield* toError(opts.failPrepare)
        }
        if (vcs === "git") {
          const prepared: PreparedCommit = {
            backend: "git",
            id: "fake-git-transaction-id",
            message: `${message}\n\nApnea-Transaction: fake-git-transaction-id`,
            branch: "refs/heads/apnea/demo",
            parent_commit: "a".repeat(40),
            tree_id: "b".repeat(40),
            ...opts.gitAnchor,
          }
          return prepared
        }
        const prepared: PreparedCommit = {
          backend: "jj",
          id: "fake-jj-transaction-id",
          message: `${message}\n\nApnea-Transaction: fake-jj-transaction-id`,
          change_id: "change0000",
          content_fingerprint: "f00dcafe0000",
          ...opts.jjAnchor,
        }
        return prepared
      }),

    completeCommit: (root, vcs, pending) =>
      Effect.gen(function* () {
        recorder.completions.push({ root, vcs, pending })
        if (opts.crashAfterCommitOnce && !crashedAfterCommit) {
          // The VCS-level commit landed (recorded above); recognition of it
          // only happens on the next call.
          crashedAfterCommit = true
          return yield* new VcsError({
            message: "simulated crash after commit, before recognition",
          })
        }
        if (opts.failComplete) {
          return yield* toError(opts.failComplete)
        }
        return opts.commitDetail ?? `${vcs} commit ${pending.id}`
      }),

    setBookmarkAtTerminus: (root, slug) =>
      Effect.gen(function* () {
        if (opts.failBookmark) {
          return yield* toError(opts.failBookmark)
        }
        recorder.bookmarks.push({ root, slug })
      }),

    runVerify: (root, blocks, timeoutMs) =>
      Effect.sync(() => {
        recorder.verifyRuns.push({ root, blocks, timeoutMs })
        return opts.verify ?? { ok: true, log: "$ true\nexit=0\n" }
      }),
  }

  return {
    layer: Layer.succeed(Vcs, Vcs.of(service)),
    recorder,
  }
}
