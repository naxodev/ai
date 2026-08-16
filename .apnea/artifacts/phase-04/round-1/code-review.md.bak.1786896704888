---
status: done
verdict: CHANGES_REQUIRED
---

## Package comparison

The Phase 4 package is aligned with the approved plan and the diff is confined to its six allowed files. The implementation does not yet satisfy the package's security and discovery contract.

## Findings

### Critical — Stale cleanup authority is publicly forgeable

`config.ts` exports both `inspectManagedRuntime()` observations and `staleCleanup(paths, proofs)`. `ArtifactProof` is only a structural type, and `staleCleanup()` never requires `proof.path` to equal the managed socket or marker path. A caller importing this module can construct matching stat fields for an arbitrary owned socket/regular file and obtain a path-based unlink closure.

Keep proof creation and cleanup construction file-local and unforgeable. Discovery should receive only internal observations and return the guarded/idempotent closure; there must be no exported generic cleanup function accepting paths/proofs.

### High — The executable's default is accidentally configured as unmanaged

With no `--socket`, `runMusicSessionDaemon()` resolves the managed socket string and passes it to `productionGraph(socketPath)`, which calls `configLayer({ socketPath })`. That marks the path as an explicit override (`runtime` is undefined), so the server does not prepare the managed directory. On a fresh machine the default daemon therefore tries to bind inside a missing directory, and it also loses managed ownership classification.

Pass absence/default intent through the graph (or pass the resolved runtime record), while retaining an explicit flag as unmanaged.

### High — Discovery consults markers in the wrong order and can authorize cleanup during startup

`inspectManagedRuntime()` parses/classifies the marker before the socket hello. Thus a healthy or incompatible daemon accompanied by a malformed/unsafe marker is rejected before hello, contrary to the rule that endpoint classification wins and markers are consulted afterward.

After a refused socket, discovery also returns `stale` whenever the socket identity is unchanged, even if the reinspection contains a live/unknown marker. That can expose socket cleanup while a conservatively live startup owner exists. Reinspect/classify the endpoint first, then return `starting` for any live/unknown marker; only a validated dead marker may join stale authority. Identity changes must fail with `MusicSessionRuntimeError`, not a plain `Error`.

### High — Filesystem hardening is incomplete

The shared `ownerOnly()` predicate accepts any owner-bit combination as long as group/other bits are clear. It therefore accepts directories and markers with modes such as `0600`, `0400`, or `0000`, and inspected sockets not exactly `0600`, despite the package requiring directory `0700` and socket/marker `0600`.

Also, if listen succeeds but `captureBoundPath()` fails, `cleanupPartial` closes the listener without removing the socket created by that partial acquisition. Preserve a proven partial-bind identity and remove only that identity on hardening failure.

### High — Required acceptance evidence is largely absent

Only resolver/preparation, one healthy discovery, and one ordinary managed-server ownership path were added. Missing focused evidence includes unsafe directory/socket/marker types, ownership and exact modes; compatible versus incompatible precedence; real stale socket and dead/live/unknown marker classifications; malformed/reset peers; stale cleanup idempotence and replacement refusal; managed bound-path replacement; second-server non-interference; and executable default versus explicit selection.

The current tests would not detect the security/classification defects above. Add the focused real-filesystem/socket matrix from package sections 7–8 with failure-safe cleanup.

## Verification

The coder reports 45 focused tests and 175 music-core tests plus build, typecheck, format, package, spawn scan, and diff check passing. Those regressions are useful, but the coder also notes the complete suite was not rerun after the final change and an isolated server rerun timed out with dangling media-control processes. In any event, the reported tests do not establish the missing Phase 4 acceptance boundaries.
