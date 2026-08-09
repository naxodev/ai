export function assertPeerVersion(version: string, range: string): void {
  if (!Bun.semver.satisfies(version, range)) {
    throw new Error(
      `installed Pi ${version} does not satisfy peer range ${range}`,
    )
  }
}
