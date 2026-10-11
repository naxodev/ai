import { Schema } from "effect"
import { createHash } from "node:crypto"

export const ApplicationProfile = Schema.Struct({
  revision: Schema.Literal(1),
  bundleIdentifier: Schema.Literal("com.sertacozercan.Kaset"),
  bundlePath: Schema.Literal("/Applications/Kaset.app"),
  executablePath: Schema.Literal(
    "/Applications/Kaset.app/Contents/MacOS/Kaset",
  ),
  architecture: Schema.Literals(["arm64", "x86_64"]),
  teamIdentifier: Schema.String.check(Schema.isPattern(/^[A-Z0-9]{10}$/)),
  cdHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  requirement: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4096),
  ),
})
export interface ApplicationProfile extends Schema.Schema.Type<
  typeof ApplicationProfile
> {}

/** Hash the exact bytes reviewed and compiled into the discovery-only helper. */
export const applicationProfileDigest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")
