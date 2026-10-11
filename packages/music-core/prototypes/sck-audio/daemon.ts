/** Throwaway executable. Starting the daemon never starts audio capture. */
import { Layer } from "effect"
import { layer as configLayer } from "../../session/config.ts"
import { runMusicSessionDaemon } from "../../session/music-sessiond.ts"
import { layerWithAudio } from "../../session/server.ts"
import { sckPrototypeLayer } from "./adapter.ts"

if (import.meta.main) {
  await runMusicSessionDaemon({
    // Reuse the local graph's refusal of the managed production socket.
    argv: ["--local-kaset-audio", ...process.argv.slice(2)],
    graph: (options) =>
      Layer.provide(layerWithAudio(sckPrototypeLayer), configLayer(options)),
  })
}
