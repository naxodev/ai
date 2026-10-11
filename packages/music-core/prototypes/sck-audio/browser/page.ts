import { safariTone, scheduleSafariTone } from "./tone.ts"

const start = document.querySelector<HTMLButtonElement>("#start")!
const stop = document.querySelector<HTMLButtonElement>("#stop")!
const status = document.querySelector<HTMLElement>("#status")!
let claimed = false
let finished = false
let audio: AudioContext | undefined
let tone: ReturnType<typeof scheduleSafariTone> | undefined
let deadline: ReturnType<typeof setTimeout> | undefined

function finish(message: string) {
  if (finished) return
  finished = true
  start.disabled = true
  stop.disabled = true
  clearTimeout(deadline)
  tone?.oscillator.stop()
  tone?.disconnect()
  status.textContent = message
  if (audio && audio.state !== "closed") {
    // Page lifetime owns context cleanup; failure remains visible and cannot retry.
    audio.close().catch(() => {
      status.textContent = "Audio cleanup failed. Close this tab."
    })
  }
}

async function playOnce() {
  if (claimed || finished) return
  claimed = true
  start.disabled = true
  stop.disabled = false
  status.textContent = "Starting…"
  const expires = performance.now() + safariTone.seconds * 1000
  deadline = setTimeout(() => finish("Finished."), safariTone.seconds * 1000)
  audio = new AudioContext({ sampleRate: safariTone.sampleRate })
  await audio.resume()
  if (finished) return
  const remaining = (expires - performance.now()) / 1000
  if (remaining <= 0) {
    finish("Stopped before playback.")
    return
  }
  if (audio.state !== "running" || document.visibilityState !== "visible") {
    finish("Stopped before playback.")
    return
  }
  tone = scheduleSafariTone(audio, Math.min(safariTone.seconds, remaining))
  tone.oscillator.onended = () => finish("Finished.")
  audio.onstatechange = () => {
    if (audio?.state !== "running") finish("Stopped after audio interruption.")
  }
  status.textContent =
    "Playing. Stops automatically after at most 15 audio seconds."
}

start.addEventListener("click", () => {
  // This handler owns startup failure and always fences further starts.
  playOnce().catch(() => finish("Audio could not start. Close this tab."))
})
stop.addEventListener("click", () => finish("Stopped."))
window.addEventListener("pagehide", () => finish("Stopped."))
document.addEventListener("visibilitychange", () => {
  if (claimed && document.visibilityState !== "visible") finish("Stopped.")
})
