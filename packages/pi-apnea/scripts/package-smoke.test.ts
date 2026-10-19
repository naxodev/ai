import { describe, expect, test } from "bun:test"
import { assertPeerVersion, selectPiVersion } from "./package-smoke-policy.ts"
import { PACKAGE_SMOKE_TIMEOUTS } from "./package-smoke.ts"

describe("package smoke peer policy", () => {
  test("tests the current host by default and preserves an explicit legacy fixture", () => {
    const range = ">=0.83.0 <0.85.0 || 0.87.1 || ^1.3.0"
    expect(selectPiVersion("1.3.0", range)).toBe("1.3.0")
    expect(selectPiVersion("1.3.0", range, "0.87.1")).toBe("0.87.1")
    expect(() => selectPiVersion("1.3.0", range, "1.2.0")).toThrow()
    expect(() => selectPiVersion("^1.3.0", range)).toThrow(
      "exact stable version",
    )
  })

  test("sets finite deadlines for pack, install, and Pi RPC", () => {
    expect(PACKAGE_SMOKE_TIMEOUTS.pack).toBeGreaterThan(0)
    expect(PACKAGE_SMOKE_TIMEOUTS.install).toBeGreaterThan(0)
    expect(PACKAGE_SMOKE_TIMEOUTS.rpc).toBeGreaterThan(0)
    expect(Object.values(PACKAGE_SMOKE_TIMEOUTS).every(Number.isFinite)).toBe(
      true,
    )
  })

  test("accepts an installed Pi version inside the declared peer range", () => {
    expect(() => assertPeerVersion("0.84.0", ">=0.83.0 <0.85.0")).not.toThrow()
  })

  test("rejects an installed Pi version outside the declared peer range", () => {
    expect(() => assertPeerVersion("0.85.0", ">=0.83.0 <0.85.0")).toThrow(
      "installed Pi 0.85.0 does not satisfy peer range >=0.83.0 <0.85.0",
    )
  })
})
