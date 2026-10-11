import { fileURLToPath } from "node:url"

export const applicationDiscovery = {
  stage: "discover",
  buildFlag: "--application-discovery",
  preflightFlag: "--check-kaset-application",
  nativeFlag: "--discover-kaset-application",
  helperIdentifier: "dev.naxo.music.sck-application-prototype",
  helperPath: fileURLToPath(
    new URL("./dist/sck-application-helper", import.meta.url),
  ),
  profilePath: fileURLToPath(
    new URL("./dist/kaset-application-profile.json", import.meta.url),
  ),
  appName: "Kaset SCK Application Discovery",
  bundleIdentifier: "dev.naxo.music.sck-application-discovery.20261011",
  evidenceDirectory: "dist/application-discovery-evidence",
} as const
