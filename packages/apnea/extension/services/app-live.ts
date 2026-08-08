import { Layer } from "effect"
import { neutralHostAdapter, type ApneaHostAdapter } from "../host-adapter.ts"
import { ConfigLive } from "./config.ts"
import { FileSystemLive } from "./file-system.ts"
import { makeHerdrLive } from "./herdr.ts"
import { RunStoreLive } from "./run-store.ts"
import { VcsLive } from "./vcs.ts"

/**
 * Blueprint layer for tool calls. Built freshly on every `Effect.provide`
 * inside runTool — no module-level ManagedRuntime.
 */
export const makeAppLive = (hostAdapter: ApneaHostAdapter) =>
  Layer.provideMerge(
    Layer.mergeAll(
      RunStoreLive,
      ConfigLive,
      VcsLive,
      makeHerdrLive(hostAdapter),
    ),
    FileSystemLive,
  )

export const AppLive = makeAppLive(neutralHostAdapter)
