# Development dependency audit assessment

The original CI audit findings are addressed by workspace dependency updates. One additional advisory remains unpatched upstream and still fails `bun run security:check`.

## Updated dependencies

| Dependency      | Previous version | Updated version |
| --------------- | ---------------- | --------------- |
| Axios           | 1.18.1           | 1.20.0          |
| brace-expansion | 5.0.9            | 5.0.12          |
| ip-address      | 10.7.0           | 10.7.3          |

Root overrides apply these updates to the existing development dependency graph. They remove 17 audit findings. Both isolated packed OpenCode consumers install without overrides and report zero vulnerabilities through `bun run security:consumers`.

## Unpatched cache advisory

[GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) affects `http-cache-semantics` through 4.2.0. The registry still publishes 4.2.0 as its latest release, and the advisory lists no patched version at this assessment on 3 October 2026.

The [upstream report](https://github.com/kornelski/http-cache-semantics/issues/56) describes a shared-cache attack. An attacker supplies `Cache-Control: max-stale` to retrieve a cached response intended for another user, including its `Set-Cookie` header.

The workspace dependency path is:

```text
@opencode/plugin (development dependency)
  → @opencode/util
    → pacote / npm tooling
      → make-fetch-happen 15.0.6
        → http-cache-semantics 4.2.0
```

`bun why http-cache-semantics` identifies `make-fetch-happen` as its only direct consumer. The installed [make-fetch-happen policy](https://unpkg.com/make-fetch-happen@15.0.6/lib/cache/policy.js) constructs cache policies with `shared: false`. No shared-cache path to the reported cross-user attack was found in this workspace graph. This assessment does not certify the separately bundled OpenCode executable or future dependency graphs.

No audit exclusion is configured. The root audit continues to report this high-severity advisory. A patched upstream release or an explicitly approved, scoped exception is needed to clear that gate. Packed-consumer audits remain separate and unchanged.
