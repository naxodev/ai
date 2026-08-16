---
status: done
verdict: APPROVED
nits: |
  The overflow test exercises the deferred-key cap; a parallel assertion for the per-key interest cap would make both bounded branches explicit, although the shared implementation is clear and this is not approval-blocking.
---

## Package comparison

The Phase 9 package remains aligned with the approved plan: production OpenCode selects the session adapter, daemon authority replaces direct provider ownership, and artwork presentation remains bounded and host-local. Round 4 changes only the permitted OpenCode system-media implementation and its existing test module.

## Findings

No blocking findings.

The deferred-artwork race from Round 3 is resolved. Each waiting host now retains its own native callback, resolver, target, identity, and clock. Admission prunes inactive hosts, selects a live host's complete context, starts work through that host, and attaches the other live equal-key interests. Disposing the original waiter can therefore no longer execute its client or resolver on behalf of a survivor.

The overflow behavior is also explicit and stable: deferred-key and per-key-interest caps retain no extra host/job and return settled no-artwork state rather than leaving an unchanged track loading indefinitely. Active jobs, deferred work, and settled entries remain bounded at 32, with slot admission still occurring after settlement and owner disposal.

## Verification

The reported focused production-cutover suite passes with 31 tests. The complete Nx matrix passes with 259 music-core tests and 128 OpenCode tests, plus typecheck, format, and package checks. Forbidden-source scans and `git diff --check` are clean. The inspected delta contains no core, Pi, manifest, lockfile, UI, documentation, or other out-of-scope product changes.
