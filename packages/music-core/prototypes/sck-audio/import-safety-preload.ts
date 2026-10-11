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
await mock.module("./application-check.ts", () => ({
  inspectApplicationDiscovery: () => {
    throw new Error("Import attempted protected application discovery")
  },
}))
await mock.module("./application-capture-check.ts", () => ({
  inspectApplicationCapture: () => {
    throw new Error("Import attempted application capture")
  },
}))
await mock.module("./safari-exclusion-check.ts", () => ({
  inspectSafariExclusion: () => {
    throw new Error("Import attempted paired capture")
  },
}))
