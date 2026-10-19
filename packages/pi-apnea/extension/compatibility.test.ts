import { expect, test } from "bun:test"
import manifest from "../package.json"

test("Pi 1.3 consumers can install the adapter alongside legacy hosts", () => {
  const range = manifest.peerDependencies["@earendil-works/pi-coding-agent"]
  for (const version of ["0.87.1", "1.3.0"])
    expect(Bun.semver.satisfies(version, range), `Pi ${version}`).toBe(true)
})

test("the development host exercises a version consumers can install", () => {
  const name = "@earendil-works/pi-coding-agent"
  expect(
    Bun.semver.satisfies(
      manifest.devDependencies[name],
      manifest.peerDependencies[name],
    ),
  ).toBe(true)
})
