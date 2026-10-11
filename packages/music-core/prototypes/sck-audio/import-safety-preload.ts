/** Prevent native work during import-safety regressions. */
import { mock } from "bun:test"
await mock.module("../../session/server.ts", () => ({
  createFakeProvider: () => ({}),
  startMusicSessionServer: () => {
    throw new Error("Import attempted live server startup")
  },
}))
await mock.module("./discovery-check.ts", () => ({
  inspectSourceDiscovery: () => {
    throw new Error("Import attempted protected discovery")
  },
}))
