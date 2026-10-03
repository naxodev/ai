# Development dependency audit assessment

The original CI audit findings are addressed by workspace dependency updates. One additional advisory remains unpatched upstream and has a narrowly scoped development-audit exception.

## Updated dependencies

| Dependency      | Previous version | Updated version |
| --------------- | ---------------- | --------------- |
| Axios           | 1.18.1           | 1.20.0          |
| brace-expansion | 5.0.9            | 5.0.12          |
| ip-address      | 10.7.0           | 10.7.3          |
| seroval         | 1.5.6            | 1.6.8           |
| smol-toml       | 1.8.0            | 1.9.0           |

Root overrides apply these updates to the existing development dependency graph. The first three updates removed 17 audit findings. The serializer and TOML updates address three further findings. Packed-consumer audits remain independent and use no overrides or exceptions.

## Serializer and TOML advisories

Solid's development dependency resolves `seroval`. The pinned Solid version requests `~1.5.4`, so an ordinary range-compatible update cannot select the patched serializer. The root override keeps the exact supported host and renderer versions unchanged.

- [GHSA-p6vx-979v-rg4c](https://github.com/advisories/GHSA-p6vx-979v-rg4c) reports unintended invocation of plugin-produced callables through Promise thenable assimilation. Its first patched version is `1.6.2`.
- [GHSA-jp82-f5mq-hwhp](https://github.com/advisories/GHSA-jp82-f5mq-hwhp) reports typed-array memory exhaustion. The advisory lists `1.6.3` as patched. Version `1.6.4` adds backing-buffer type validation. The current override retains the repository's newer `1.6.8` resolution, including that validation.
- [GHSA-r4xh-jqrq-34v2](https://github.com/advisories/GHSA-r4xh-jqrq-34v2) reports quadratic TOML key parsing. Nx resolves this development dependency. The `1.9.0` parser replaces that path with a linear implementation and returns null-prototype tables.

The security-policy tests reject affected nested resolutions and exercise the serializer resolved through Solid itself. A small malformed backing object reproduces the unsafe allocation path without requesting excessive memory. Valid typed views still round-trip. A parser check verifies Nx's installed TOML version and covers dotted keys, tables, arrays, and dates. Compatibility alone cannot detect a stale link to an affected parser.

The initial local follow-up used Seroval `1.6.4` and smol-toml `1.9.0`, with lifecycle scripts disabled. A forced frozen reinstall corrected a Solid-to-seroval link that still pointed at `1.5.6`; the behavior regression detected it. PR integration retains `main`'s Seroval `1.6.8`, smol-toml `1.9.0`, and package versions. It adds stronger installed-dependency checks rather than downgrading those updates.

`bun run security:check` passes with the existing cache exception below unchanged. These overrides do not patch the prebuilt OpenCode executable. The [host-provided dependency boundary](opencode-compatibility.md#host-provided-dependencies) separates development resolution, packed consumers, and embedded host libraries.

The full `bun run check` gate also passed, including all six package smokes, packed-consumer audits, and minimum-Bun checks.

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

## Approved exception

Approved on 3 October 2026: exclude only `GHSA-ch52-4w7c-c8xp` from the root development audit. `bun run security:check` runs the security-policy tests before invoking `bun audit --ignore GHSA-ch52-4w7c-c8xp`. Every other advisory still fails that audit. Bare `bun audit` continues to report the excluded warning.

The mandatory guard requires exactly `http-cache-semantics@4.2.0`, with `make-fetch-happen@15.0.6` as its only declared direct consumer. It rejects direct workspace use and checks the SHA-256 of the reviewed `lib/cache/policy.js` implementation. Changes to these cache dependencies, their callers, or the policy source fail the guard before the audit exception runs.

Packed-consumer audits have no exception. This approval covers the reviewed development graph, not the prebuilt OpenCode executable or a shared-cache deployment.

Review this exception by 3 November 2026, or when upstream publishes a fix, whichever comes first. Remove it after updating to a fixed version. If the guarded graph or policy changes, reassess reachability before changing the guard.
