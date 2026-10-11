/** Fixed unrelated-source marker. Scheduling alone never creates an audio context. */
export const safariTone = Object.freeze({
  frequency: 2113,
  peak: 0.1,
  seconds: 15,
  sampleRate: 48000,
})

export function scheduleSafariTone(
  context: BaseAudioContext,
  seconds: number = safariTone.seconds,
) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > safariTone.seconds)
    throw new Error("Invalid remaining tone duration")
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  const stereo = context.createChannelMerger(2)
  oscillator.type = "sine"
  oscillator.frequency.value = safariTone.frequency
  gain.gain.value = safariTone.peak
  oscillator.connect(gain)
  gain.connect(stereo, 0, 0)
  gain.connect(stereo, 0, 1)
  stereo.connect(context.destination)
  const start = context.currentTime
  oscillator.start(start)
  // The audio clock stops the source even if browser timers are throttled.
  oscillator.stop(start + seconds)
  return {
    oscillator,
    disconnect() {
      oscillator.disconnect()
      gain.disconnect()
      stereo.disconnect()
    },
  }
}
