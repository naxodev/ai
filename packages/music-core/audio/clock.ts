/**
 * Each process has its own monotonic origin. Bun and Node do not share
 * `hrtime` or `performance.now`. Audio freshness maps the client origin into
 * the daemon origin. Native helper clock conversion is not verified here.
 */
export const localMonotonicMs = (): number => performance.now()

export type AudioClockMapping = {
  readonly offsetMs: number
  readonly uncertaintyMs: number
  /** Conservative daemon time: uncertainty is added so old bytes expire early. */
  readonly daemonNow: (localNowMs: number) => number
}

export const mapAudioClock = (input: {
  readonly clientSendMs: number
  readonly clientReceiveMs: number
  readonly daemonSampleMs: number
}): AudioClockMapping => {
  const rtt = Math.max(0, input.clientReceiveMs - input.clientSendMs)
  const uncertaintyMs = rtt / 2
  const offsetMs = input.daemonSampleMs - (input.clientSendMs + uncertaintyMs)
  return {
    offsetMs,
    uncertaintyMs,
    daemonNow: (localNowMs) => localNowMs + offsetMs + uncertaintyMs,
  }
}
