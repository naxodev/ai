/** Build only. Does not install a plugin, launch a daemon, or start capture. */
import solidPlugin from "@opentui/solid/bun-plugin"
import { daemonArguments } from "../../music-core/session/music-sessiond.ts"

const index = process.argv.indexOf("--socket")
const socket = index >= 0 ? process.argv[index + 1] : undefined
if (!socket?.startsWith("/"))
  throw new Error(
    "Pass --socket with a separate absolute local daemon socket path",
  )
daemonArguments(["--socket", socket, "--local-kaset-audio"])
const outdir = `${import.meta.dir}/../local-audio/dist`
const result = await Bun.build({
  entrypoints: [`${import.meta.dir}/../local-audio/tui.ts`],
  outdir,
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [solidPlugin],
  define: { LOCAL_MUSIC_AUDIO_SOCKET: JSON.stringify(socket) },
})
if (!result.success)
  throw new AggregateError(result.logs, "Local audio sidebar build failed")
console.log(`Local-only plugin directory: ${outdir}`)
console.log("Not installed. No daemon started and no audio captured.")
