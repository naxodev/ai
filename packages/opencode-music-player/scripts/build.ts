import solidPlugin from "@opentui/solid/bun-plugin"
import { buildOpenCodePlugin } from "../../../scripts/opencode-build.ts"

await buildOpenCodePlugin("opencode-music-player", solidPlugin)
