---
status: done
verdict: CHANGES_REQUIRED
---

## Findings

### High — The protocol-version skew finding remains unresolved

The plan still only rejects unsupported protocol versions. It does not define what happens when independently installed OpenCode and Pi clients carry different `music-core` versions while a healthy but incompatible daemon owns the singleton socket. Phase 2 still needs an explicit compatibility/upgrade policy and acceptance coverage proving that supported mixed versions share one provider and an unsupported client fails actionably without unlinking the live socket, disrupting healthy clients, or entering a spawn/reconnect loop.

### Medium — Node compatibility still is not exercised

The Phase 2 verification command remains:

```sh
bun packages/music-core/dist/music-sessiond.js --help
```

The Pi smoke still intentionally exits without starting a daemon. Therefore no planned check starts the packaged daemon under Node, performs a socket handshake, and verifies clean shutdown from an isolated packed install. Add that verification; a Bun `--help` invocation does not substantiate the stated Node-compatible deliverable.
