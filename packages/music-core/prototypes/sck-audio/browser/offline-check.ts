/** Render the real graph into memory. This creates no realtime output or capture. */
import { safariTone, scheduleSafariTone } from "./tone.ts"

async function check() {
  const rate = safariTone.sampleRate
  const context = new OfflineAudioContext(2, rate * 16, rate)
  scheduleSafariTone(context)
  const buffer = await context.startRendering()
  const left = buffer.getChannelData(0)
  const right = buffer.getChannelData(1)
  let peak = 0
  let difference = 0
  let power = 0
  let sine = 0
  let cosine = 0
  let tail = 0
  const first = rate * 2
  const end = rate * 8
  for (let i = 0; i < left.length; i++) {
    const value = left[i]!
    if (!Number.isFinite(value) || !Number.isFinite(right[i]!))
      throw new Error("nonfinite")
    peak = Math.max(peak, Math.abs(value))
    difference = Math.max(difference, Math.abs(value - right[i]!))
    if (i >= rate * 15)
      tail = Math.max(tail, Math.abs(value), Math.abs(right[i]!))
    if (i < first || i >= end) continue
    const angle = (2 * Math.PI * 2113 * i) / rate
    power += value * value
    sine += value * Math.sin(angle)
    cosine += value * Math.cos(angle)
  }
  const count = end - first
  const meanPower = power / count
  const markerPower = (2 * (sine * sine + cosine * cosine)) / (count * count)
  const purity = markerPower / meanPower
  if (
    Math.abs(peak - 0.1) > 1e-5 ||
    Math.abs(meanPower - 0.005) > 1e-6 ||
    purity < 0.999 ||
    difference !== 0 ||
    tail !== 0
  )
    throw new Error("waveform")
  return {
    status: "passed",
    peak,
    meanPower,
    purity,
    stereoDifference: difference,
    post15SecondsPeak: tail,
  }
}

// This fixture owns its rendering promise and exposes only aggregate test evidence.
check().then(
  (result) => {
    document.body.textContent = JSON.stringify(result)
  },
  () => {
    document.body.textContent = JSON.stringify({ status: "failed" })
  },
)
