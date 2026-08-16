---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 12 intent matches the approved plan, but the implementation changes `packages/music-core/index.ts`, which the package explicitly lists under “Files not to touch,” and adds new public configuration exports. The package is internally inconsistent here: it asks the harness to use an installed runtime-path resolver through the package name even though Phase 11 did not export that resolver, while simultaneously forbidding a root-surface change. Resolve that package/surface conflict rather than silently widening the public API in this phase.

## Findings

### High — The Node harness does not load the packed client through Node's installed module graph

`installedSmoke()` uses Bun to bundle `harness.mjs` and all of its `@naxodev/music-core` imports into `session/installed-smoke.mjs`, then runs that generated bundle with Node. The later `import.meta.resolve("@naxodev/music-core")` check proves that an installed root file exists, but the client/config implementation being exercised was resolved and transformed by Bun at bundle time; Node does not import the packed package root or its declared `effect` dependency at lifecycle runtime.

This bypasses the package's central acceptance condition that the `.mjs` lifecycle harness import the public API by package name under Node. The coder result acknowledges that direct Node loading fails because the package exports TypeScript from `node_modules`; that is a package-surface defect or package-design conflict, not evidence the installed Node contract works. Do not certify it with a bundling workaround unless the phase package is explicitly revised to define that weaker boundary.

### High — Failure paths can hang or leave exact children alive

The shared `command()` helper has no timeout or failure-finalizer for its `Bun.spawn` child, including the lifecycle harness. Inside the harness, initial `createReconnectingMusicSessionClient()` acquisition and `client.dispose()` are also unbounded. In final cleanup, a timed-out graceful daemon wait sends `SIGKILL` but does not await the post-kill exit. The outer verifier tracks neither the harness process nor a process group, and merely removes the temporary root after `command()` returns.

A stuck startup, disposal, or harness therefore prevents outer cleanup indefinitely; a failed graceful kill can race temporary-root removal and smoke completion. Add explicit bounded ownership for startup, disposal, harness exit, and daemon exit; terminate only the retained child/group and always await its final exit before removing artifacts.

### High — The required invalid installed-daemon invocation is absent

The generated harness never invokes the manifest-selected daemon with an invalid `--idle-grace-ms` value. It therefore does not prove status `1`, an actionable config diagnostic, absence of that invocation's socket/runtime artifacts, or exact child release, all of which are explicit Phase 12 acceptance requirements.

### Medium — The successful daemon can still discover host-installed provider tools

The successful launcher uses `env: { PATH: "/usr/bin:/bin" }`. The package requires a PATH rooted in a newly created empty temporary bin directory so provider-unavailable replay is deterministic and developer/system tools cannot affect the smoke. Create the owned empty bin directory and use only that path.

### Medium — CLI validation bypasses the required Effect configuration boundary

`daemonArguments()` converts and validates `idleGraceMs` itself with `Number.isSafeInteger` before constructing `MusicSessionOptions`. The package explicitly requires the parser to put the parsed value into options and let existing Effect config resolution validate it, avoiding duplicated policy. Keep only argument presence/parsing in the CLI and assert invalid values fail through the existing config/error-status boundary.

### Medium — Protocol acceptance is weaker than specified

The harness accepts every nonnegative `selectedRevision`; it does not verify that the revision falls within the installed package's supported `PROTOCOL` range. Import the installed protocol bounds and assert the negotiated revision is supported.

## Verification

The reported dry-pack check, successful smoke run, 261-test core regression matrix, formatting/typecheck/build/package checks, artifact scan, and `git diff --check` pass. Those results do not cover the missing invalid-option branch, failure cleanup, deterministic provider isolation, or direct Node package loading described above.
