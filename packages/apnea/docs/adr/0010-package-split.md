# ADR 0010: Split the engine and Pi adapter

## Status

Accepted.

## Context

The original package combined a standalone CLI, workflow engine, protocol resources, and Pi integration. This made the host-neutral CLI depend on Pi-specific launch behavior and prevented consumers from installing the engine alone.

## Decision

Publish the workflow engine and CLI as `@naxodev/apnea`. Publish Pi registration, Pi resources, and Pi-specific role launch behavior as `@naxodev/pi-apnea`.

Both adapters bind the operation registry exported by `@naxodev/apnea`. The Pi adapter calls registry operations in process. It does not invoke the CLI as a subprocess.

The core exposes only the operation registry, result formatting, command parsing, resource-root lookup, and the `ApneaHostAdapter` launch hooks. Pi supplies those hooks when it creates its registry.

The current incompatible `@naxodev/pi-apnea` line depends on `@naxodev/apnea` with `^0.2.0`. Compatible core patch releases flow through that range. For an incompatible line, the core manifest is pre-staged at the new minor so the workspace remains installable while Nx coordinates the adapter's minor release.

## Consequences

The CLI package installs and runs without Pi. Installing the Pi adapter installs the core transitively and registers Pi extensions, skills, and prompts. Protocol documentation, schemas, briefs, and Herdr resources have one owner in the core package.
