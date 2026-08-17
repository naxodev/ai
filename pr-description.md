---
status: done
---

# refactor(music): centralize cross-host media sessions

## TL;DR

Pi and OpenCode independently sampled and commanded media providers, so their transport and media views could race and diverge. One owner-only Effect v4 session now owns transport and authoritative media state for both hosts, with isolation verified across 24 clients.

## Files to review

**Files to review (44, +22453 / -3557):**

| File | Why |
|---|---|
| `packages/music-core/session/coordinator.ts` *(start here)* | Defines provider authority, polling, global FIFO command handling, state fan-out, and artwork ownership. |
| `packages/music-core/session/protocol.ts` | Defines validated hello negotiation, capability gates, correlated requests, and revisioned state frames. |
| `packages/music-core/session/server.ts` | Owns the Unix listener, negotiated-client lifecycle, bounded connection queues, and shutdown sequence. |
| `packages/music-core/session/client.ts` | Connects or starts one generation, fences stale replay, and makes command loss explicit. |
| `packages/music-core/session/config.ts` | Establishes owner-only runtime paths, bounded limits, and startup-marker coordination. |
| `packages/music-core/session/provider.ts` | Moves provider sampling, event recovery, transport, and native artwork behind the scoped Effect service. |
| `packages/music-core/session/music-sessiond.ts` and `packages/music-core/index.ts` | Package the host-neutral Node daemon and expose the host-facing session contract. |
| `packages/opencode-music-player/system-media.ts` and `packages/opencode-music-player/index.tsx` | Adapt shared state and commands to OpenCode while retaining host-local artwork and presentation. |
| `packages/pi-music-dock/extensions/music-dock/index.ts` | Adapts one reconnecting client to Pi status, waveform, commands, and shortcuts. |
| `packages/music-core/tests/session-{coordinator,server,client,protocol}.test.ts` and host tests | Exercise authority, lifecycle, protocol, packaging, and adapter boundaries. |

## Why

Separate host-owned provider graphs could observe the same machine at different times and issue transport concurrently. That made disagreement possible even when each host was locally correct: one UI could render stale media state while the other changed playback.

## How

- Owner-only Unix-socket startup coordination selects a single provider graph; the hardened bind remains the final singleton authority.
- Effect v4 scopes and Layers own the provider, coordinator, listener, connections, queues, polling, and finalizers as one daemon graph.
- Schema-validated hello and capability negotiation establish a compatible generation, then revisioned replay establishes the state a client may treat as authoritative.
- Bounded per-client queues and bounded artwork work isolate slow or failing peers from healthy connections and transport.
- Reconnecting clients retain presentation until a new generation completes hello and replay, but never replay uncertain commands.
- OpenCode and Pi stay presentation adapters while the packaged Node daemon remains host-neutral.

## Reviewer notes

- **Global command order.** OpenCode and Pi submit to one FIFO; if a connection drops before a response, the admitted command is indeterminate and reconnect never retries it.
- **Snapshot authority.** Monotonic revisions and daemon instance IDs fence delayed samples, callbacks, and optimistic projections so an older generation cannot overwrite accepted state.
- **Conservative runtime cleanup.** Startup markers, sockets, and bind locks require owner, mode, type, and identity proof; cleanup refuses changed paths and never follows a replacement or symlink.
- **Negotiated artwork bounds.** Native artwork is capability-gated, identity-checked before and after reading, deduplicated, and bounded independently of state and transport delivery.
- **Idle lifetime.** Only the last negotiated client starts the idle grace; a new negotiated client cancels it before scoped shutdown.
- **Host boundary.** Core code owns provider work and ordering, while OpenCode retains catalog/rendering work and Pi retains status and waveform presentation.

## Tests

Run:

- `bun run check`
- `bunx nx run music-core:smoke`
- `bunx nx run opencode-music-player:smoke`
- `bunx nx run pi-music-dock:smoke`

Manual certification: OpenCode `0.0.0-next-17386` and Pi `0.84.0` loaded the checkout packages in their isolated host setup and controlled the same selected VLC item; both control directions, Pi reload and `/quit`, post-Pi OpenCode control, normal OpenCode exit, canonical VLC restoration, daemon-generation continuity, and owned cleanup passed.

## Residual risk

Live coverage used pinned pre-release host versions, one selected VLC item on macOS, and one already-running daemon generation. Provider, host-version, and platform variance remain outside that certification.
