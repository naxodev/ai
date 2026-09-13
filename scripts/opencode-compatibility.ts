import compatibility from "./opencode-compatibility.json"

export { compatibility }

export const hostDependencies = {
  ...compatibility.peerDependencies,
  "solid-js": compatibility.devDependencies["solid-js"],
}

export function assertCompatibilitySet(set: typeof compatibility) {
  if (
    set.host.version !== set.peerDependencies["@opencode/plugin"] ||
    set.host.version !== set.devDependencies["@opencode/theme"]
  )
    throw new Error("OpenCode CLI, plugin, and theme must use the same release")
  if (
    set.peerDependencies["@opentui/core"] !==
    set.peerDependencies["@opentui/solid"]
  )
    throw new Error("OpenTUI core and Solid must use the same release")
  for (const version of [
    set.host.version,
    ...Object.values(set.peerDependencies),
    ...Object.values(set.devDependencies),
  ])
    if (!/^\d+\.\d+\.\d+$/.test(version))
      throw new Error(
        `Compatibility set requires exact stable versions: ${version}`,
      )
}

type Manifest = {
  name: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  devDependencies?: Record<string, string>
}

export function assertOpenCodeCompatibility(
  manifests: readonly Manifest[],
  hostVersion = compatibility.host.version,
) {
  assertCompatibilitySet(compatibility)
  if (hostVersion !== compatibility.host.version)
    throw new Error(
      `Unsupported OpenCode host ${hostVersion}; expected ${compatibility.host.version}`,
    )
  for (const manifest of manifests) {
    if (
      manifest.peerDependencies?.["solid-js"] !== undefined ||
      manifest.peerDependenciesMeta?.["solid-js"] !== undefined
    )
      throw new Error(
        `${manifest.name}: Solid must use the exact host/development pin without npm peer metadata`,
      )
    for (const name of Object.keys(hostDependencies)) {
      if (
        name in (manifest.dependencies ?? {}) ||
        name in (manifest.optionalDependencies ?? {})
      )
        throw new Error(
          `${manifest.name}: host-provided ${name} must not be installed as a production dependency`,
        )
      if (
        name in compatibility.peerDependencies &&
        manifest.peerDependenciesMeta?.[name]?.optional !== true
      )
        throw new Error(
          `${manifest.name}: host-provided ${name} must be an optional peer`,
        )
    }
    const expected = {
      peerDependencies: compatibility.peerDependencies,
      devDependencies: {
        ...compatibility.peerDependencies,
        ...compatibility.devDependencies,
      },
    }
    for (const scope of ["peerDependencies", "devDependencies"] as const) {
      for (const [name, version] of Object.entries(expected[scope])) {
        if (manifest[scope]?.[name] !== version)
          throw new Error(
            `${manifest.name}: ${name} must be exactly ${version}; received ${manifest[scope]?.[name]}`,
          )
      }
    }
    for (const scope of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "devDependencies",
    ] as const) {
      if (
        Object.keys(manifest[scope] ?? {}).some((name) =>
          name.startsWith("@opencode-ai/"),
        )
      )
        throw new Error(
          `${manifest.name}: legacy OpenCode dependencies are unsupported`,
        )
    }
  }
}

export async function checkOpenCodeCompatibility() {
  const names = ["opencode-vim", "opencode-music-player"]
  const manifests = await Promise.all(
    names.map(
      (name) =>
        Bun.file(
          new URL(`../packages/${name}/package.json`, import.meta.url),
        ).json() as Promise<Manifest>,
    ),
  )
  assertOpenCodeCompatibility(manifests)
  const lock = Bun.JSONC.parse(
    await Bun.file(new URL("../bun.lock", import.meta.url)).text(),
  ) as {
    workspaces: Record<
      string,
      Omit<Manifest, "name"> & { optionalPeers?: string[] }
    >
    packages: Record<string, [string, ...unknown[]]>
  }
  assertOpenCodeCompatibility(
    names.map((name) => ({
      ...lock.workspaces[`packages/${name}`],
      peerDependenciesMeta: Object.fromEntries(
        (lock.workspaces[`packages/${name}`]?.optionalPeers ?? []).map(
          (peer) => [peer, { optional: true }],
        ),
      ),
      name: `bun.lock:${name}`,
    })),
  )
  for (const [name, version] of Object.entries({
    ...compatibility.peerDependencies,
    ...compatibility.devDependencies,
  })) {
    const resolutions = Object.entries(lock.packages).filter(
      ([key]) => key === name || key.endsWith(`/${name}`),
    )
    if (
      !resolutions.length ||
      resolutions.some(([, [resolved]]) => resolved !== `${name}@${version}`)
    )
      throw new Error(`bun.lock must resolve only ${name}@${version}`)
  }
}

if (import.meta.main) {
  await checkOpenCodeCompatibility()
  console.log(
    `OpenCode compatibility set verified: ${compatibility.host.version}`,
  )
}
