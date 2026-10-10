# Audio helper distribution spike

This record covers the distribution evidence that the [production plan](music-audio-visualization-plan.md) requires before native capture can ship. It reports what this machine proves and what it cannot prove. The spike does not change audio routing, install drivers, or capture audio.

## Environment measured

| Item                                 | Value                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| macOS                                | 27.0.1, build 26A434                                                                            |
| Architecture                         | arm64                                                                                           |
| Xcode                                | `/Applications/Xcode.app`                                                                       |
| Swift compiler                       | `/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc` |
| Notary tool                          | `/Applications/Xcode.app/Contents/Developer/usr/bin/notarytool` 1.1.3 (42)                      |
| Codesigning identities               | **0 valid**                                                                                     |
| Apple Development certificate        | `nachovc1410@gmail.com (85Z588QSGW)`, expired 2023-03-30                                        |
| Developer ID Application certificate | none                                                                                            |
| Provisioning profiles                | none                                                                                            |
| Login keychain                       | unlocked (`no-timeout`)                                                                         |

`security find-identity -v -p codesigning` reports zero identities with an unlocked keychain. The only developer certificate is expired. No Developer ID Application certificate exists on this machine.

## Verified here

1. A universal helper builds with the installed toolchain. Compiling `AudioProbe.swift` for `arm64-apple-macos14.2` and `x86_64-apple-macos14.2` and combining the slices with `lipo` produces a valid two-architecture executable. Each compile takes about a minute.
2. `lipo` discards the code signature. The individual slices verify (`codesign --verify --strict` exits 0), but the combined universal binary fails with `code object is not signed at all`. Any universal helper needs an explicit signing step after `lipo`, and verification must run on the final artifact.
3. Explicit signing after `lipo` succeeds. `codesign --force --sign - --identifier <id>` produces a universal binary that passes `codesign --verify --strict`, with the requested identifier and no team identifier.
4. Tampering is detected. Appending one byte to a signed helper makes strict verification fail with `main executable failed strict validation` and exit status 1. A helper integrity check is therefore implementable.
5. `notarytool` runs directly from its Xcode path. The broken `xcrun` launcher on this Mac is not a blocker for notarization.

## Blocked

No Developer ID Application certificate exists. Therefore this machine cannot:

- Sign a distributable helper with a stable team identity.
- Notarize or staple a helper, or test quarantined and offline launch.
- Verify distributable-helper permission attribution, permission persistence across updates, or revoke and deny behavior.
- Establish stable permission attribution across supported Bun or Node launch layouts.

Apple's [notarization guidance](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) requires a Developer ID certificate, the hardened runtime, and a secure timestamp for distributed executables. An ad-hoc signature provides none of these.

## Design consequences

- The helper signature covers the code hash. Every rebuild produces a different ad-hoc signature. Whether macOS re-prompts for system-audio permission after an ad-hoc helper changes is **unverified**; the plan already lists this as an open question, and it needs a user-approved permission experiment.
- TCC attributed the failed local helper request to Hex, the responsible application, in the [shared-daemon live test](music-local-daemon-audio-evidence.md#permission-diagnosis). A manual grant to Hex preceded successful capture. Stable attribution for the shipped layout remains unverified and must be tested before choosing a packaging layout.
- Integrity verification is worth implementing regardless of route. The spike proves it detects modification.
- A universal helper is feasible, but it costs two compiles and a mandatory re-sign. A thin per-architecture artifact is the cheaper alternative if size and build time matter more than one download for both architectures.

## Routes

| Route                                    | Requires                                                                   | Status                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Developer ID signed and notarized helper | Paid Apple Developer membership and a Developer ID Application certificate | Blocked on the account decision; the plan's preferred route                                             |
| Ad-hoc signed helper                     | Nothing beyond this machine                                                | Works locally for lifecycle work; not distributable, because Gatekeeper and stable identity are missing |
| Build from source on install             | Swift or Xcode on every user machine                                       | Rejected; the plan requires that users need no developer tools                                          |
| External tool such as CAVA or BlackHole  | A user-installed tool and its own authorization                            | Changes the integration shape; not verified in this spike                                               |

## Release gate still unmet

The helper proves mapped-file ownership with public `PROC_PIDREGIONPATHINFO` only. It does not call the private region flavor. A zero-sized record is not ownership; the walk continues and fails closed if the cursor cannot advance. Synthetic checks cover a zero-sized prefix, a foreign owner, and an incomplete scan. One metadata-only check on this Mac agreed with the private walk for six GPU processes and selected only Kaset. It did not capture audio, and it does not clear signing or the permission matrix.

These remain unverified and must pass before any release: signed distribution, notarization, ticket handling, quarantined and offline launch, shipped-helper prompt attribution, permission persistence across updates and package paths, the deny/grant/revoke matrix, supported helper-process attribution, additional players, device changes, and sustained performance.

## Recommended next step

Continue local-only work behind the daemon capture adapter, and keep production capture unavailable. Ad-hoc signing is sufficient for that work. The ownership walk is now the public region API. One metadata-only Kaset check passed on this Mac; signing and the permission matrix remain open. A Developer ID certificate alone does not clear the remaining gates.
