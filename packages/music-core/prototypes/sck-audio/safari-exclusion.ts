import { fileURLToPath } from "node:url"

export const safariExclusion = {
  stage: "exclude",
  buildFlag: "--safari-exclusion",
  preflightFlag: "--check-safari-reference",
  nativeFlag: "--exclude-safari-audio",
  helperIdentifier: "dev.naxo.music.sck-safari-exclusion-prototype",
  helperPath: fileURLToPath(
    new URL("./dist/sck-safari-exclusion-helper", import.meta.url),
  ),
  profilePath: fileURLToPath(
    new URL("./dist/kaset-exclusion-profile.json", import.meta.url),
  ),
  safariProfilePath: fileURLToPath(
    new URL("./dist/safari-exclusion-profile.json", import.meta.url),
  ),
  appName: "Kaset Safari Exclusion",
  bundleIdentifier: "dev.naxo.music.sck-safari-exclusion.20261011",
  evidenceDirectory: "dist/safari-exclusion-evidence",
  tonePagePath: fileURLToPath(
    new URL("./dist/controlled-sources/safari-tone.html", import.meta.url),
  ),
  tonePageDigest:
    "ca07954793ac65f95b44916cafe7e16a4e2f6e2bb34ce9a6c79bcc8f5e8cd86a",
} as const
