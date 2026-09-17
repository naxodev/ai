import { expect, test } from "bun:test"
import {
  assertCompatibilityDocumentation,
  compatibilitySection,
} from "./compatibility-docs.ts"

test("a core-floor or runtime change cannot leave stale compatibility documentation", () => {
  const manifest = {
    name: "@naxodev/example",
    engines: { bun: ">=1.3.0" },
    dependencies: { "@naxodev/music-core": "^0.1.3" },
  }
  const old = compatibilitySection(manifest)
  const updated = compatibilitySection({
    ...manifest,
    engines: { bun: ">=1.3.7" },
    dependencies: { "@naxodev/music-core": "^0.1.4" },
  })
  expect(() => assertCompatibilityDocumentation(old, updated)).toThrow(
    "contradicts",
  )
  expect(() => assertCompatibilityDocumentation(updated, updated)).not.toThrow()
})

test("peer ranges remain distinct from exact Pi test dependencies and platform evidence", () => {
  const section = compatibilitySection({
    name: "@naxodev/pi-example",
    peerDependencies: { "@earendil-works/pi-tui": ">=0.83.0 <0.85.0" },
    devDependencies: { "@earendil-works/pi-tui": "0.84.2" },
  })
  expect(section).toContain("Declared peer:")
  expect(section).toContain("Pi test dependency:")
  expect(section).toContain("does not establish tested platform support")
})
