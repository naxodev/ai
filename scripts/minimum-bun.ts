import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { runBoundedCommand } from "./bounded-process.ts"
import { hostDependencies, compatibility } from "./opencode-compatibility.ts"

export function minimumBun(range: string): string {
  const match = /^>=(\d+\.\d+\.\d+)$/.exec(range)
  if (!match) throw new Error(`Unsupported Bun engine range: ${range}`)
  return match[1]!
}

async function main() {
  const root = resolve(import.meta.dir, "..")
  const work = await mkdtemp(join(tmpdir(), "minimum-bun-"))
  const command = async (args: string[], cwd: string, timeoutMs = 180_000) => {
    const result = await runBoundedCommand(args, {
      cwd,
      timeoutMs,
      label: args.slice(0, 3).join(" "),
    })
    if (result.exitCode !== 0)
      throw new Error(`${args.join(" ")}\n${result.stdout}\n${result.stderr}`)
    return result.stdout.trim()
  }
  try {
    const manifests = await Promise.all(
      [...new Bun.Glob("packages/*/package.json").scanSync(root)]
        .sort()
        .map(async (file) => ({
          file,
          manifest: JSON.parse(await readFile(join(root, file), "utf8")) as {
            name: string
            engines?: { bun?: string }
          },
        })),
    )
    const selected = manifests.filter(({ manifest }) => manifest.engines?.bun)
    const binaries = new Map<string, string>()
    for (const { manifest } of selected) {
      const version = minimumBun(manifest.engines!.bun!)
      if (binaries.has(version)) continue
      const platform = process.platform
      const arch = process.arch === "arm64" ? "aarch64" : process.arch
      if (
        !["darwin", "linux", "win32"].includes(platform) ||
        !["x64", "aarch64"].includes(arch)
      )
        throw new Error(
          `Unsupported minimum-runtime runner: ${platform}/${arch}`,
        )
      const packageName = `@oven/bun-${platform === "win32" ? "windows" : platform}-${arch}`
      const dir = join(work, `runtime-${version}`)
      await mkdir(dir)
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          private: true,
          dependencies: { [packageName]: version },
        }),
      )
      await command(
        ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"],
        dir,
      )
      const binary = join(
        dir,
        "node_modules",
        packageName,
        "bin",
        platform === "win32" ? "bun.exe" : "bun",
      )
      if ((await command([binary, "--version"], dir, 10_000)) !== version)
        throw new Error(`Wrong isolated Bun version for ${version}`)
      binaries.set(version, binary)
    }
    for (const { file, manifest } of selected) {
      const project = file.split("/")[1]!
      const consumer = join(work, project)
      await mkdir(consumer)
      const dependencies: Record<string, string> = {}
      const host = project.startsWith("opencode-")
      if (host)
        Object.assign(dependencies, hostDependencies, {
          "@opencode/theme": compatibility.devDependencies["@opencode/theme"],
        })
      for (const name of project === "opencode-music-player"
        ? ["music-core", project]
        : [project]) {
        const directory = join(root, "packages", name)
        // Build with the workspace toolchain. Only installed behavior uses the minimum runtime.
        if (name === "apnea") await command(["bun", "run", "build"], directory)
        const output = await command(
          ["npm", "pack", "--silent", "--pack-destination", consumer],
          directory,
        )
        const archive = output.split("\n").at(-1)!
        if (basename(archive) !== archive || !archive.endsWith(".tgz"))
          throw new Error(`Invalid pack output: ${output}`)
        dependencies[`@naxodev/${name}`] = `file:${join(consumer, archive)}`
      }
      await writeFile(
        join(consumer, "package.json"),
        JSON.stringify({
          private: true,
          type: "module",
          dependencies,
          // Reproduce the verified host's Solid singleton despite OpenTUI's stale peer metadata.
          ...(host
            ? {
                overrides: {
                  "solid-js": compatibility.devDependencies["solid-js"],
                },
              }
            : {}),
        }),
      )
      await command(
        ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"],
        consumer,
      )
      const version = minimumBun(manifest.engines!.bun!)
      const binary = binaries.get(version)!
      const probe =
        project === "music-core"
          ? `import { strict as assert } from "node:assert";
import { formatMs, emptyPlayer, acquireCatalogArtwork } from "@naxodev/music-core";
assert.equal(formatMs(61000), "1:01");
assert.notEqual(emptyPlayer(), emptyPlayer());
let calls = 0;
const result = await acquireCatalogArtwork({ title: "Track", artist: "Artist", album: "Album", duration_ms: 1000 }, { retryDelayMs: 0, fetch: async () => { calls++; return new Response("busy", {status:503}); } });
assert.equal(result.kind, "exhausted"); assert.equal(calls, 3);
console.log("format, independent state, bounded acquisition retries verified");`
          : project === "apnea"
            ? `import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { packageRoot, OPERATIONS } from "@naxodev/apnea";
assert.ok((await readFile(packageRoot() + "/briefs/coder.md", "utf8")).includes("coder"));
assert.ok(OPERATIONS.some(x => x.verb === "abandon"));
console.log("installed API and resources verified");`
            : `import { strict as assert } from "node:assert";
import plugin from "${manifest.name}/tui";
assert.equal(typeof plugin.setup, "function");
assert.equal(typeof plugin.id, "string");
console.log("compiled plugin definition loads with explicit standalone peers");`
      await writeFile(join(consumer, "probe.ts"), probe)
      console.log(
        `${manifest.name} on Bun ${version}: ${await command([binary, "run", "probe.ts"], consumer, 30_000)}`,
      )
      if (project === "apnea") {
        const cli = join(consumer, "node_modules/@naxodev/apnea/dist/cli.js")
        const status = JSON.parse(
          await command([binary, cli, "status", "--json"], consumer, 30_000),
        ) as { ok: boolean; data: { has_state: boolean } }
        if (!status.ok || status.data.has_state)
          throw new Error("Isolated Apnea status failed")
      }
    }
    console.log(
      "Minimum Bun consumer checks passed. OpenCode renderer behavior remains covered by exact-host smokes, not runtime substitution inside its prebuilt executable.",
    )
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

if (import.meta.main) await main()
