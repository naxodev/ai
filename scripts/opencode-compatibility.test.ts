import { expect, test } from "bun:test"
import {
  assertCompatibilitySet,
  assertOpenCodeCompatibility,
  checkOpenCodeCompatibility,
  compatibility,
} from "./opencode-compatibility.ts"

const manifest = () => ({
  name: "fixture",
  dependencies: {} as Record<string, string>,
  peerDependencies: { ...compatibility.peerDependencies },
  peerDependenciesMeta: Object.fromEntries(
    Object.keys(compatibility.peerDependencies).map((name) => [
      name,
      { optional: true },
    ]),
  ),
  devDependencies: {
    ...compatibility.peerDependencies,
    ...compatibility.devDependencies,
  },
})

test("editing the contract cannot bless mismatched host or renderer releases", () => {
  const host = structuredClone(compatibility)
  host.host.version = "2.0.4"
  expect(() => assertCompatibilitySet(host)).toThrow("same release")
  const renderer = structuredClone(compatibility)
  renderer.peerDependencies["@opentui/core"] = "0.5.11"
  expect(() => assertCompatibilitySet(renderer)).toThrow("same release")
})

test("the workspace and lock use the tested host contract", async () => {
  await checkOpenCodeCompatibility()
})

test("a core-only upgrade fails before incompatible branded renderables reach the host", () => {
  const mixed = manifest()
  mixed.peerDependencies["@opentui/core"] = "0.5.11"
  expect(() => assertOpenCodeCompatibility([manifest(), mixed])).toThrow(
    "@opentui/core must be exactly",
  )
})

test("a plugin or host upgrade needs a newly tested compatibility set", () => {
  const upgraded = manifest()
  upgraded.peerDependencies["@opencode/plugin"] = "2.0.4"
  expect(() => assertOpenCodeCompatibility([upgraded])).toThrow(
    "@opencode/plugin must be exactly",
  )
  expect(() => assertOpenCodeCompatibility([manifest()], "2.0.4")).toThrow(
    "Unsupported OpenCode host",
  )
})

test("ranges cannot claim compatibility beyond executable evidence", () => {
  const widened = manifest()
  widened.peerDependencies["@opentui/solid"] = "^0.5.10"
  expect(() => assertOpenCodeCompatibility([widened])).toThrow(
    "@opentui/solid must be exactly",
  )
})

test("host libraries cannot restore unused compiler or tracing dependencies in consumer installs", () => {
  for (const [name, version] of Object.entries(
    compatibility.peerDependencies,
  )) {
    const installed = manifest()
    installed.dependencies[name] = version
    expect(() => assertOpenCodeCompatibility([installed])).toThrow(
      "production dependency",
    )
    expect(() =>
      assertOpenCodeCompatibility([
        {
          ...manifest(),
          optionalDependencies: { [name]: "" },
        },
      ]),
    ).toThrow("production dependency")
    const required = manifest()
    required.peerDependenciesMeta[name]!.optional = false
    expect(() => assertOpenCodeCompatibility([required])).toThrow(
      "optional peer",
    )
    const missing = manifest()
    delete missing.peerDependenciesMeta[name]
    expect(() => assertOpenCodeCompatibility([missing])).toThrow(
      "optional peer",
    )
  }
})

test("development checks use the same renderer that the host supplies", () => {
  const different = manifest()
  different.devDependencies["@opentui/core"] = "0.5.11"
  expect(() => assertOpenCodeCompatibility([different])).toThrow(
    "@opentui/core must be exactly",
  )
})

test("Solid remains an exact host dependency without npm's conflicting optional peer graph", () => {
  const different = manifest()
  different.devDependencies["solid-js"] = "1.9.12"
  expect(() => assertOpenCodeCompatibility([different])).toThrow(
    "solid-js must be exactly",
  )
  const production = manifest()
  production.dependencies["solid-js"] = "1.9.15"
  expect(() => assertOpenCodeCompatibility([production])).toThrow(
    "production dependency",
  )
  expect(() =>
    assertOpenCodeCompatibility([
      {
        ...manifest(),
        peerDependencies: {
          ...compatibility.peerDependencies,
          "solid-js": "1.9.15",
        },
      },
    ]),
  ).toThrow("without npm peer metadata")
  const metadata = manifest()
  metadata.peerDependenciesMeta["solid-js"] = { optional: true }
  expect(() => assertOpenCodeCompatibility([metadata])).toThrow(
    "without npm peer metadata",
  )
})
