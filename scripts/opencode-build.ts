import { mkdir, rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { BunPlugin } from "bun"
import { checkOpenCodeCompatibility } from "./opencode-compatibility.ts"

export async function buildOpenCodePlugin(
  project: "opencode-vim" | "opencode-music-player",
  solidPlugin: BunPlugin,
) {
  await checkOpenCodeCompatibility()
  const directory = fileURLToPath(
    new URL(`../packages/${project}/`, import.meta.url),
  )
  const outdir = `${directory}dist`
  await rm(outdir, { recursive: true, force: true })
  await mkdir(outdir)
  const result = await Bun.build({
    entrypoints: [`${directory}index.tsx`],
    outdir,
    target: "bun",
    format: "esm",
    packages: "external",
    plugins: [solidPlugin],
  })
  if (!result.success)
    throw new AggregateError(result.logs, `Could not build ${project}`)
  await Bun.write(`${outdir}/tui.js`, 'export { default } from "./index.js"\n')
  console.error(`Built ${project}; all package imports remain external`)
}
