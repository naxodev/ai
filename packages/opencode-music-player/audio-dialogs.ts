/** The host owns dialog display. We own only the wait and its late result. */
export function createAudioDialogWaits() {
  const pending = new Set<() => void>()
  return {
    run<A>(show: () => Promise<A | undefined>): Promise<A | undefined> {
      return new Promise((resolve, reject) => {
        let settled = false
        const finish = (value: A | undefined) => {
          if (settled) return
          settled = true
          pending.delete(cancel)
          resolve(value)
        }
        const fail = (error: unknown) => {
          if (settled) return
          settled = true
          pending.delete(cancel)
          reject(error)
        }
        const cancel = () => finish(undefined)
        pending.add(cancel)
        try {
          // Both callbacks handle the host's late completion after cancellation.
          show().then(finish, fail).catch(reject)
        } catch (error) {
          fail(error)
        }
      })
    },
    cancel() {
      for (const cancel of [...pending]) cancel()
    },
  }
}
