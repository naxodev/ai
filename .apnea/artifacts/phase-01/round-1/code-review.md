---
status: done
verdict: CHANGES_REQUIRED
---

## Findings

### High: Partial stream payloads are emitted as authoritative snapshots

`packages/music-core/system-media.ts:140-153` treats any payload with a boolean `playing` value or one non-empty identity field as complete. Therefore payloads such as `{ "playing": false }` and `{ "title": "Song" }` pass the gate, mutate the backend clock, reset retry backoff, and emit normalized snapshots with missing state. The first example is decoded as an idle player, while the second invents defaults for all omitted fields.

The phase package requires partial payloads that cannot represent a complete sample to emit nothing. Validate the presence and types of the complete stream sample shape, while still allowing a complete idle payload whose values are empty or null. Add regressions for boolean-only and identity-only payloads followed by a complete valid payload.

## Verification

`bunx nx run-many -t typecheck test format:check package:check --projects=music-core` passes. The current incomplete-envelope test covers empty and elapsed-only payloads, but not the partial payloads accepted by this gate.
