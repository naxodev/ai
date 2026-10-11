/** Build only. Never opens a browser, creates audio, or starts a native helper. */
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

const style = `body { color: #192332; background: #f4f6f8; font: 18px system-ui; margin: 8vh auto; max-width: 38rem; padding: 1.5rem; } h1 { font-size: 2rem; } button { font: inherit; padding: .7rem 1.3rem; margin: .5rem .5rem .5rem 0; border: 2px solid #263f61; border-radius: .4rem; background: #fff; color: #192332; } button:disabled { color: #566273; border-color: #9ca6b3; } button:focus-visible { outline: 3px solid #1f61c4; outline-offset: 3px; } #status { min-height: 3rem; }`
const digest = (value: string) =>
  createHash("sha256").update(value).digest("base64")

async function bundle(entry: string) {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, entry)],
    target: "browser",
    format: "iife",
    minify: true,
  })
  if (!result.success || result.outputs.length !== 1)
    throw new Error("Tone bundle failed")
  const script = await result.outputs[0]!.text()
  if (/<\/script/i.test(script))
    throw new Error("Unexpected embedded script terminator")
  return script
}

function html(script: string, body: string) {
  const policy = `default-src 'none'; script-src 'sha256-${digest(script)}'; style-src 'sha256-${digest(style)}'; img-src data:; base-uri 'none'; form-action 'none'`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><link rel="icon" href="data:,"><title>Safari isolation test tone</title><style>${style}</style></head><body>${body}<script>${script}</script></body></html>\n`
}

export async function buildSafariTone() {
  const directory = join(import.meta.dir, "../dist/controlled-sources")
  await mkdir(directory, { recursive: true })
  const page = html(
    await bundle("page.ts"),
    `<main><h1>Safari test tone</h1><p>Plays a 2113 Hz tone at a fixed signal level. Starts only when you press Start.</p><p>Plays for at most 15 audio seconds. Press Stop to end it sooner. Leaving this tab also requests a stop.</p><button id="start" type="button">Start once</button><button id="stop" type="button" disabled>Stop</button><p id="status" role="status">Ready. No tone is playing.</p></main>`,
  )
  const fixture = html(
    await bundle("offline-check.ts"),
    "Checking the tone in memory. No sound is played.",
  )
  await writeFile(join(directory, "safari-tone.html"), page)
  await writeFile(join(directory, "offline-tone-check.html"), fixture)
  const hashes = {
    "safari-tone.html": createHash("sha256").update(page).digest("hex"),
    "offline-tone-check.html": createHash("sha256")
      .update(fixture)
      .digest("hex"),
  }
  await writeFile(
    join(directory, "hashes.json"),
    JSON.stringify(hashes, null, 2) + "\n",
  )
  return { directory, hashes }
}

if (import.meta.main) console.log(JSON.stringify(await buildSafariTone()))
