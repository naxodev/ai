---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 7 package remains aligned with the approved plan. Round 10 uses only allowed source/test paths and substantially improves the vertical slice, but the package's required concurrency, cancellation, client, and non-interference acceptance remains absent.

## Findings

### High — Coordinator ownership, deduplication, capacity, and cancellation are still untested

The new fake controls were added only to the Promise-based `FakeProvider`; the Effect-native `CoordinatorProviderFixture` still has no artwork controls, and `session-coordinator.test.ts` adds only configuration assertions. There is no deterministic test for:

- pre-read stale rejection and post-read state-change rejection;
- concurrent equal-key sharing across callers;
- distinct in-flight capacity, deterministic settled eviction, and re-read;
- provider failure removal followed by successful retry;
- interruption during admission, first-caller disconnect while joiners remain, and coordinator-scope shutdown/finalization;
- state publication and transport progress while artwork is blocked.

These are load-bearing semantics of the new scoped cache and were the source of multiple prior implementation defects. Add Effect-native gates/counters and focused coordinator/real-server tests that force each race under bounded cleanup.

### High — Server and client outcome/lifecycle coverage remains incomplete

The single selected-server test proves one available response, one settled cache hit, pre-read mismatch, unsupported capability, and subsequent command health. It does not exercise concurrent requests from different clients, post-read stale completion, provider failure and retry, unavailable/malformed/too-large final responses, final encoded fallback containment, disconnect/disposal while pending, blocked-read connection isolation, or reconnect generation no-replay/late completion.

No explicit or reconnecting client artwork test was added. The package requires truthful `CONNECTION_LOST` versus `DISPOSED`, no queue/replay after replacement, and generation fencing. Add those tests, including correlation of multiple simultaneous request IDs and continued state/command health.

### Medium — Native adapter coverage is still narrower than the package

The adapter tests now cover the exact command, value mismatches, empty/malformed artwork strings, decoded boundary, unsupported backend seam, and command failure. They still do not inject malformed JSON text, missing/null native IDs, noncanonical-but-decodable base64, timeout behavior as a distinct execution failure, or demonstrate that ordinary sample/stream commands remain `--no-artwork` alongside the new read. Add the missing boundary cases, especially the strict missing-ID rule.

## Verification

Round 10 reports 191 passing tests across the required five files, a green 248-test Nx build/typecheck/test/format/package matrix, clean boundary scan, and `git diff --check`. Baseline and current added tests are green; the verdict is based on the required acceptance cases that are not present.

## Resolved findings

Configuration now shares a finite 192 KiB decoded/262,144-character schema maximum, derives a conservative frame-bound effective limit, and rejects frames too small for correlated artwork responses. Default current clients negotiate `native-artwork`, while an explicit old peer can omit it. The new protocol, adapter, and selected-server tests establish canonical schema behavior, exact native command/full value mismatch handling, basic payload boundaries, capability gating, authoritative pre-check, and settled cache reuse.
