import solidPlugin from "@opentui/solid/bun-plugin"
import { build } from "./run.ts"

await build()
const result = await Bun.build({
  entrypoints: [`${import.meta.dir}/tui.tsx`],
  outdir: `${import.meta.dir}/dist`,
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [solidPlugin],
  define: { AUDIO_PROTOTYPE_ROOT: JSON.stringify(import.meta.dir) },
})
if (!result.success)
  throw new AggregateError(result.logs, "Could not build local audio prototype")
console.log(`Local-only plugin directory: ${import.meta.dir}/dist`)
