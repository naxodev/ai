---
status: done
verdict: APPROVED
---

## Package comparison

The Phase 11 package is aligned with the approved plan. It is limited to removing host migration scaffolding and finalizing package/public surfaces after both host cutovers. The mechanical OpenCode smoke-fixture update is necessary for the renamed seam and does not enter the later packed-host certification phase.

## Findings

No blocking findings.

OpenCode now exposes a narrow `SessionMedia` contract containing only projected player retrieval, required transport operations, session events, host-local artwork completion, and asynchronous disposal. Generic backend selection, provider-era identity/authentication/search fields, optional direct-backend methods, timer/delay compatibility seams, the unused transport-kind argument, and obsolete direct-sample presentation merging are removed without changing the bounded seek, command, lifecycle, artwork, authority, or disposal paths.

Core retains `createSystemMedia()` and its compatibility exports while continuing to expose the reconnecting client and host-consumed protocol types from the package root. The package verifier now checks the root export and daemon executable mappings, requires every intended runtime/package entry, and rejects every unexpected packed entry.

Both host manifests use the publishable `^0.1.0` core dependency while the lockfile continues to resolve the local workspace package. OpenCode's exact host pins and Pi's development pins, peer ranges, extension declaration, and runtime dependency placement remain unchanged. Pi production source is untouched.

## Verification

The reported focused suites pass with 2 core public-API tests, 33 OpenCode seam tests, and 10 Pi controller tests. The three-project Nx matrix passes with 261 music-core, 126 OpenCode, and 23 Pi tests plus typecheck, format, and package checks. Core dry-pack verification, forbidden-symbol scans, host-pin assertions, artifact scans, and `git diff --check` are clean. The inspected product delta is confined to package-authorized files and leaves no retained tarball or runtime artifact.
