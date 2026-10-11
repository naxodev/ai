import { fileURLToPath } from "node:url"

export const applicationCapture = {
  stage: "capture",
  buildFlag: "--application-capture",
  preflightFlag: "--check-kaset-application",
  nativeFlag: "--capture-kaset-application",
  helperIdentifier: "dev.naxo.music.sck-application-capture-prototype",
  helperPath: fileURLToPath(
    new URL("./dist/sck-application-capture-helper", import.meta.url),
  ),
  profilePath: fileURLToPath(
    new URL("./dist/kaset-capture-profile.json", import.meta.url),
  ),
  appName: "Kaset SCK Application Capture",
  bundleIdentifier: "dev.naxo.music.sck-application-capture.20261011",
  evidenceDirectory: "dist/application-capture-evidence",
  signalRmsThreshold: 0.0001,
  // Exact profile used by the successful, separately approved discovery check.
  discoveryProfileDigest:
    "64bd9ed8cd6cc2c6a08920cda94afc1251379cc6d9442aaff7ae1d968e082780",
} as const
