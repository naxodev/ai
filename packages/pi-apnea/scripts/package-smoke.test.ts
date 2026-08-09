import { describe, expect, test } from "bun:test"
import { assertPeerVersion } from "./package-smoke-policy.ts"

describe("package smoke peer policy", () => {
  test("accepts an installed Pi version inside the declared peer range", () => {
    expect(() => assertPeerVersion("0.84.0", ">=0.83.0 <0.85.0")).not.toThrow()
  })

  test("rejects an installed Pi version outside the declared peer range", () => {
    expect(() => assertPeerVersion("0.85.0", ">=0.83.0 <0.85.0")).toThrow(
      "installed Pi 0.85.0 does not satisfy peer range >=0.83.0 <0.85.0",
    )
  })
})
