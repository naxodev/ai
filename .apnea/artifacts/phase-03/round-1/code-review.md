---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 3 package is aligned with approved Plan Phase 3. The product diff is confined to `packages/pi-music-dock/scripts/package-smoke.ts` and does not change Pi pins, peer ranges, extension behavior, core/OpenCode code, documentation, or broader gates.

## Findings

### High — Failed process-group termination can hang before fail-safe retention runs

`packages/pi-music-dock/scripts/package-smoke.ts:283-297` records a `terminateProcessGroup()` failure and then unconditionally awaits `stdout.done` and `stderr.done`. When the exact group could not be terminated, that still-live process or one of its descendants may keep either pipe open indefinitely. The smoke then never throws into the outer `finally`, so it neither retries bounded teardown nor reaches the required retained-root diagnostic. This violates the package's explicit bounded teardown and unconfirmed-termination policy.

Do not await live-process streams without a bound after termination is unconfirmed. Capture the available output under a bound (or use the existing buffered snapshot), throw into the outer cleanup path, and ensure an ultimately unconfirmed group fails while retaining/reporting the root.

### Medium — Installed compatibility is checked against the source ranges, not the packed extension's ranges

`packages/pi-music-dock/scripts/package-smoke.ts:185-209` reads the installed dock manifest only for `name` and `pi.extensions`; the compatibility checks at lines 197-205 reuse ranges from the repository source manifest. The phase package specifically requires each installed exact Pi version to be checked against the packed extension's declared peer range. This is observably different when the supported optional archive argument supplies an external packed dock.

Read the installed dock's `peerDependencies` and validate both installed exact versions against those packed ranges, while retaining the source-manifest checks that govern the selected pins.

## Verification

The coder supplied successful output for all four phase verification commands. The happy path proves isolated Pi `0.84.0`, packed dock/core roots, command registration, status-zero exit, and normal cleanup. It does not exercise the unconfirmed-termination branch or establish packed-manifest peer compatibility described above.
