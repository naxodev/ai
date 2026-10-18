import { expect, test } from "bun:test"
import manifest from "../package.json"

test("the development host exercises a version consumers can install", () => {
  const name = "@earendil-works/pi-coding-agent"
  expect(
    Bun.semver.satisfies(
      manifest.devDependencies[name],
      manifest.peerDependencies[name],
    ),
  ).toBe(true)
})
