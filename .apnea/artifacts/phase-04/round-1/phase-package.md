---
status: done
---

# Phase 4 package — document the completed architecture as current

## Intent

Update the workspace overview, three music package READMEs, and the preserved architecture field guide so they describe the delivered machine-local session daemon as the current design. Remove the stale story in which every host owns a provider/poll/transport runtime and a broker is only a future scale path.

Treat `docs/music-session-architecture.html` as the explanation page and preserve its visual/accessibility system. Keep each README focused on its package: the root README is an overview, `music-core` is public-surface/reference material, and each host README explains installation, host-local responsibilities, controls, and verification. Link to the field guide instead of duplicating its full architecture in every README.

This is a documentation-only phase. Do not change behavior, tests, package metadata, pins, smokes, or generated artifacts.

## Exact steps

### 1. Preserve the approved implementation and verify every claim from source

1. Run `jj status` before editing.
2. Preserve approved Phase 3 commit `dee247d7`, exact-pinned OpenCode Phase 2, packed-core Phase 1, every earlier verified commit, unrelated changes, and `.apnea/state.json`.
3. Work through the configured Pi role profile in a regular pane. Do not commit or squash; the orchestrator performs the approved-phase `jj squash`.
4. Before writing, use these existing source files as the factual boundary:
   - `packages/music-core/index.ts` for the public package surface;
   - `packages/music-core/session/config.ts` for managed runtime, bounds, startup, poll, and idle defaults;
   - `packages/music-core/session/protocol.ts` for revisions, capabilities, replay frames, errors, and artwork outcomes;
   - `packages/music-core/session/client.ts` for explicit and reconnecting client behavior;
   - `packages/music-core/session/coordinator.ts`, `provider.ts`, and `server.ts` for daemon ownership, global serialization, fan-out, artwork, and shutdown;
   - `packages/opencode-music-player/system-media.ts` and `index.tsx` for the OpenCode boundary;
   - `packages/pi-music-dock/extensions/music-dock/index.ts` for the Pi boundary;
   - existing `packages/music-core/tests/session-*.test.ts` for claims about 20/24 clients, singleton startup, compatibility, reconnect, bounds, idle exit, and mixed hosts.
5. Do not document internal-only symbols as public. In particular, do not add `resolveMusicSessionRuntimePaths` to the public API or tell package consumers to import it.
6. Use only behavior present in the approved code/tests. If a sentence cannot be tied to those files, omit it instead of inventing an option, error, timing guarantee, or deployment mode.

### 2. Update the workspace overview

In `README.md`:

1. Keep the existing short workspace overview and package links.
2. State that OpenCode and Pi use lightweight clients connected to one same-user, machine-local music-session daemon, which owns one provider and fans state out to all clients.
3. Add a relative link to `docs/music-session-architecture.html` as the detailed architecture explanation.
4. Keep the existing development command and contribution link unchanged unless wording must be adjusted for accuracy.

Do not turn the root README into a copy of the field guide or add installation instructions already owned by package READMEs.

### 3. Rewrite the music-core README around the public session boundary

In `packages/music-core/README.md`:

1. Replace the stale purpose/status claims that Pi and OpenCode directly consume provider discovery, backend clocks, subscriptions, and polls.
2. Explain the current topology:
   - many host clients connect over one owner-only same-user Unix socket;
   - one daemon owns the selected provider, event subscription, playback clock, recovery polling, state/status authority, global transport queue, and native artwork reads;
   - clients receive immediate hello/status/state replay and later revisioned updates;
   - host presentation stays outside core.
3. Explain Effect v4 ownership at an architectural level without presenting internals as public API:
   - `Config` validates runtime limits/timing;
   - `Schema` validates untrusted protocol/provider data;
   - Layers/scopes own provider, coordinator, listener, connections, and finalizers;
   - `Schedule` paces startup/reconnect;
   - `SubscriptionRef` owns replayable state/status;
   - bounded queues/semaphores/streams isolate command, sampling, fan-out, and artwork work.
4. Update the **Public surface** block to match exports from `packages/music-core/index.ts`, including the currently exported explicit/reconnecting session client types/functions, `MusicSessionClientError`, protocol/capability/status/state/artwork types, `PROTOCOL`, and `baselineCapabilities`.
5. Retain the low-level `createSystemMedia()` API in the public-surface reference and describe it as an intentional compatibility/low-level provider API. Do not imply that either production host still calls it directly.
6. Add a concise public reconnecting-client example only if every import and method is exported from `index.ts`. Use `createReconnectingMusicSessionClient`, a unique client ID, a valid `hostKind`, `baselineCapabilities`, subscriptions, transport calls, and awaited `dispose()`; do not use internal runtime or daemon-server imports.
7. Explain lifecycle/compatibility behavior concisely:
   - concurrent missing-endpoint callers converge through startup-marker coordination, while socket bind remains final singleton authority;
   - hello negotiates a supported revision/capability intersection;
   - supported mixed package versions share the live daemon;
   - incompatibility is terminal for that healthy generation and does not authorize unlink/replacement;
   - reconnect retains the last accepted state for presentation, adopts only a new handshaken generation, and never replays commands;
   - commands unresolved at connection loss are indeterminate;
   - last-client departure starts the bounded idle grace and final cleanup removes only owned artifacts.
8. Explain bounds without publishing unstable implementation trivia: finite frames/queues/pending requests, local slow/abusive-client disconnection, coalescible state fan-out, mandatory response preservation, O(1) provider observation, and O(N) client fan-out. Cite the verified 24-client scenario as capacity evidence, not a hard maximum.
9. Replace the stale provider-change section with a short low-level compatibility note or remove it if its detail now distracts from the session boundary. Do not describe host-owned 3/5/8-second polling as current.
10. Link to `../../docs/music-session-architecture.html` for the full mental model.

### 4. Correct the OpenCode package documentation

In `packages/opencode-music-player/README.md`:

1. Replace the stale Architecture section. State that one reconnecting session client supplies replay/live state, provider status, transport, and daemon-owned native artwork bytes.
2. State what OpenCode still owns locally: plugin/controller lifecycle, Solid compact/sidebar UI, optimistic transport presentation, seek coalescing, notifications, waveform projection, iTunes catalog fallback/download, conversion, the bounded presentation cache/jobs, and Kitty/half-block rendering.
3. Remove claims that the plugin owns a provider subscription, backend sampling lane, playback clock, 3/5/8-second provider poll, or provider-stream retry timer.
4. Explain teardown accurately: plugin disposal unsubscribes local listeners, stops local presentation work, and awaits/disposes only its session client. Other clients keep the shared daemon alive.
5. Correct both stale OpenCode version references from `0.0.0-next-17041` to the exact current manifest/smoke pin `0.0.0-next-17386`.
6. Keep requirements, installation, controls, artwork rendering setup, community, security, and license sections useful and intact.
7. Clarify Artwork ownership:
   - the daemon performs the bounded native `media-control get --now` read and validates recording identity;
   - OpenCode keeps iTunes Search fallback, downloads, conversion, cache/job ownership, and terminal rendering;
   - artwork failure never blocks playback state.
8. Update Development wording so the workspace smoke is described as packing OpenCode/core and launching the exact manifest-selected OpenCode CLI from an isolated install.
9. Link the Architecture section to `../../docs/music-session-architecture.html` instead of duplicating every protocol detail.

### 5. Correct the Pi package documentation

In `packages/pi-music-dock/README.md`:

1. Replace the stale Architecture section. State that each live Pi TUI session owns one reconnecting client plus its local status/waveform/notification lifecycle.
2. State that the daemon—not Pi—owns provider discovery, provider stream/polling, playback clock, global transport ordering, and native media reads.
3. Explain reload/shutdown accurately: mark the old Pi session inactive, remove client listeners, stop the waveform interval, clear status, and await client disposal. Reloading or exiting Pi does not stop a daemon still serving OpenCode or another client.
4. Keep the documented supported peer range as Pi 0.83.x/0.84.x, and add that the packed smoke selects exactly Pi `0.84.0` from the package's tested development pin. Do not narrow the peer range to the smoke pin.
5. Keep install/remove commands and the command/shortcut table unchanged unless source verification shows a mismatch.
6. Update manual verification so it checks shared behavior rather than per-host ownership:
   - status and controls reflect the shared daemon state;
   - `/reload` leaves one Pi client/status and does not duplicate daemon/provider ownership;
   - closing Pi leaves another host healthy;
   - final-client exit permits daemon idle shutdown and owned socket cleanup.
7. Remove claims that Pi teardown releases its own provider subscription, provider poll, backend clock, samples, or provider process.
8. Update Development wording so the package smoke is described as packing Pi/core, installing exact `@earendil-works/pi-coding-agent@0.84.0` and `@earendil-works/pi-tui@0.84.0`, loading via RPC, checking all three commands, and proving prompt process exit.
9. Link the Architecture section to `../../docs/music-session-architecture.html`.

### 6. Convert the preserved HTML field guide from future broker to current daemon

Edit the body/content of `docs/music-session-architecture.html` while preserving its established visual system. The page is an explanation, so organize it around why ownership and failure behavior work rather than copying TypeScript definitions.

#### Present the current topology

1. Update the description, masthead lede, navigation labels, headings, prose, diagrams, tables, captions, and ARIA labels so the page consistently presents:

   ```text
   20+ OpenCode/Pi clients → one same-user Unix socket daemon → one provider
   ```

2. Replace the opening flow's host-controller provider ownership with a current flow in which host-local presentation communicates through the session client/Unix socket to the daemon Effect graph and its single provider authority.
3. Remove every statement that the direct per-host provider topology is current, that no cross-process coordination exists, or that a broker should be added later.
4. Remove the `Direct / current` versus `Broker / scale path` recommendation. Reuse the existing visual components for the current daemon topology/capacity explanation rather than redesigning the page.

#### Explain ownership and shutdown

5. Rewrite the ownership table around separate client and daemon responsibilities:
   - each host owns one client, subscriptions, host UI/waveform/notifications, and OpenCode-only catalog/render work;
   - the daemon owns listener, coordinator, provider Layer, provider event source, poll scheduler, global command lane, replay refs, and native artwork reads.
6. Explain scoped Effect v4 ownership and the selected shutdown order accurately: stop/refuse new acceptance, interrupt coordinator work, drain dependent connection children, finalize provider/event ownership, then close the listener and remove its exact owned socket path.
7. Explain that signal, defect, and idle paths converge on the same idempotent cleanup boundary and remove only artifacts whose identity/ownership is proven.

#### Explain startup, protocol, replay, and generations

8. Describe owner-only runtime discovery, exact-owner startup-marker leases, detached daemon launch, socket bind as final singleton authority, and 20 concurrent first clients converging on one generation.
9. Explain hello negotiation with revision ranges and capabilities. Supported legacy/current clients can share one daemon; an incompatible client receives actionable terminal range details and cannot unlink, kill, or replace the healthy generation.
10. Explain immediate status/state replay, monotonic state revisions, and daemon instance IDs as generation fences.
11. Explain reconnect without command replay: retain last accepted presentation state, settle admitted in-flight commands as connection-lost/indeterminate exactly once, ignore late old-generation work, and adopt a replacement only after its hello/replay succeeds.

#### Explain bounded concurrency and cost

12. Replace per-host sampling/transport lanes with current daemon/client lanes:
   - one provider sampling/event authority;
   - one global FIFO command queue across OpenCode and Pi;
   - bounded per-connection inbound work and pending requests;
   - bounded/coalescing state fan-out with mandatory response/status handling;
   - bounded deduplicated native artwork work.
13. Explain local failure containment: one abusive or paused reader can be disconnected/backpressured without blocking 23 healthy peers or terminating the daemon.
14. Update the capacity/cost table to current values: provider observation/subscription/poll ownership is O(1), fan-out and client presentation are O(N), and OpenCode catalog/render work remains proportional to OpenCode clients. State that 24 alternating clients are verified evidence and not a configured maximum.
15. Explain last-client idle behavior: a completed new connection cancels the grace; grace expiry follows the common shutdown path; the next client can start/adopt a new generation.

#### Explain artwork and host boundaries

16. State that the daemon validates complete recording identity before and after native artwork reads, deduplicates concurrent identical work, and bounds payload/cache work.
17. State that iTunes lookup, image download, conversion, colors/cells, Kitty graphics, half-block rendering, and UI completion events remain OpenCode-local. Pi does not request/render artwork.
18. Preserve the host comparison's current controls/presentation differences while replacing any claim that hosts directly own provider/poll/sample/transport authority.

#### Preserve accessibility and visual behavior

19. Keep the skip link targeting `#content`, labeled sticky navigation, logical heading order, table headers/captions, `role="img"` descriptions, source links, visible focus states, responsive rules, print rules, and `prefers-reduced-motion` behavior.
20. Update every diagram/capacity ARIA label to describe the new content; do not leave stale accessible text hidden behind a visually updated diagram.
21. Preserve the dark field-guide visual language, type/color tokens, mobile stacking, and print legibility. Change CSS only when required to support revised content; do not perform an unrelated redesign.
22. Keep all relative source links valid and retain links to the three package READMEs.

### 7. Perform a documentation consistency pass

Before verification:

1. Search all five edited files for old per-host ownership claims, future-broker wording, stale OpenCode `next-17041`, and claims that OpenCode/Pi own provider polls/subscriptions.
2. Check version statements against current manifests: OpenCode exact `0.0.0-next-17386`; Pi supported 0.83.x/0.84.x and exact tested `0.84.0`.
3. Re-read every public symbol/example against `packages/music-core/index.ts`. Remove internal imports and invented methods/options.
4. Check that the HTML and READMEs agree on provider ownership, command ordering, artwork boundaries, reconnect behavior, and idle exit.
5. Avoid sycophantic preamble, “simply/just/easy,” a conclusion section, phantom advanced sections, and repeated prose that should be a relative link.
6. Do not claim that docs verification replaces the later full repository or mixed-host phase.

## Files to touch

- `README.md`
- `packages/music-core/README.md`
- `packages/opencode-music-player/README.md`
- `packages/pi-music-dock/README.md`
- `docs/music-session-architecture.html`

## Files not to touch

- `packages/music-core/index.ts`
- `packages/music-core/session/**`
- `packages/music-core/tests/**`
- `packages/music-core/package.json`
- `packages/music-core/project.json`
- `packages/opencode-music-player/index.tsx`
- `packages/opencode-music-player/system-media.ts`
- `packages/opencode-music-player/types.ts`
- `packages/opencode-music-player/tests/**`
- `packages/opencode-music-player/package.json`
- `packages/opencode-music-player/scripts/**`
- `packages/pi-music-dock/extensions/**`
- `packages/pi-music-dock/test/**`
- `packages/pi-music-dock/package.json`
- `packages/pi-music-dock/scripts/**`
- `package.json`
- `bun.lock`
- `.apnea/state.json`
- Any unrelated dirty file or generated documentation/build artifact

## Acceptance checks

- All five documentation files describe one same-user machine-local daemon/provider as the current architecture, not a future option.
- The docs accurately cover Effect v4 Layer/scope ownership, singleton startup, negotiated revision/capability compatibility, immediate replay/revisions, one global FIFO, bounded client/fan-out/artwork work, slow-reader isolation, reconnect generations without command replay, indeterminate commands, idle exit, and exact-owned cleanup.
- The cost model is O(1) provider observation and O(N) fan-out/presentation, with verified 20+ client evidence rather than an invented maximum.
- The public API reference matches `packages/music-core/index.ts` and does not expose/import internal runtime resolver or server/provider symbols.
- Native artwork reads are daemon-owned and bounded; OpenCode-local catalog/download/conversion/cache/rendering and Pi's no-artwork boundary remain clear.
- OpenCode requirements/docs use exact `0.0.0-next-17386`. Pi docs retain supported 0.83.x/0.84.x and identify exact `0.84.0` as the packed-smoke pin.
- Host docs describe only their client and presentation ownership; stale host provider subscription/poll/playback-clock/sample-lane claims are removed.
- The HTML retains its skip link, labeled navigation/diagrams, logical structure, source links, responsive/print behavior, reduced-motion support, focus treatment, and established visual language.
- No behavior, source, tests, manifests, pins, smokes, lockfiles, or unrelated worktree content changes.

## Verify commands

Run from the repository root:

```sh
bunx prettier --check README.md packages/music-core/README.md packages/opencode-music-player/README.md packages/pi-music-dock/README.md docs/music-session-architecture.html
! rg -n 'Direct / current|Broker / scale path|future broker|when coordination is required' docs/music-session-architecture.html packages/music-core/README.md packages/opencode-music-player/README.md packages/pi-music-dock/README.md
! rg -n '0\.0\.0-next-17041' README.md packages/opencode-music-player/README.md docs/music-session-architecture.html
jj diff --summary
jj status
```

The diff summary must contain only the five documentation paths above, apart from dispatcher-owned `.apnea` artifacts/state that were already present. Do not run `bun run check`, package smokes, or mixed-host verification in this phase; those are later gates.

## Dependencies

- Approved exact Pi Phase 3 at `dee247d7`, exact OpenCode Phase 2 at `6613d6d1`, and packed-core Phase 1 at `863c6e7b`.
- The complete verified migration through those phases.
- Current source/tests as the factual architecture boundary.
- The existing `docs/music-session-architecture.html` visual/accessibility implementation as the preserved baseline.

## Non-goals

- Product, protocol, runtime, test, package, smoke, pin, lockfile, changelog, or release changes.
- Exporting internal session configuration/server/provider APIs or adding a new docs site/build system.
- Redesigning the field guide, replacing its visual language, generating diagrams, or moving it to another format/path.
- New installation workflows, remote/cloud brokers, launchd/service management, durable history, fleet coordination, or feature proposals.
- Full repository checks, live mixed-host verification, PR-description work, publishing, pushing, or opening a PR.
- Committing, squashing, editing `.apnea/state.json`, or cleaning unrelated worktree changes.
