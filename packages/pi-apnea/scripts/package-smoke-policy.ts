export function assertPeerVersion(version: string, range: string): void {
  if (!Bun.semver.satisfies(version, range)) {
    throw new Error(
      `installed Pi ${version} does not satisfy peer range ${range}`,
    )
  }
}

export function selectPiVersion(
  developmentVersion: string,
  peerRange: string,
  override?: string,
): string {
  const version = override ?? developmentVersion
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error(
      `Pi smoke version must be an exact stable version: ${version}`,
    )
  assertPeerVersion(version, peerRange)
  return version
}
