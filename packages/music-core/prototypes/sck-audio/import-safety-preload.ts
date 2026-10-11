/** Prevent any live graph during the import-safety regression. */
import { mock } from "bun:test"
await mock.module("../../session/server.ts", () => ({
  createFakeProvider: () => ({}),
  startMusicSessionServer: () => {
    throw new Error("Import attempted live server startup")
  },
}))
