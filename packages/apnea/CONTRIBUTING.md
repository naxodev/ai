# Contributing to Apnea

See the workspace [CONTRIBUTING.md](../../CONTRIBUTING.md) for setup, release, and trusted publishing instructions.

Run the core package gates with:

```sh
bunx nx run-many -t typecheck test format:check package:check smoke --projects=apnea
```

Run the Pi adapter gates with:

```sh
bunx nx run-many -t typecheck test format:check package:check smoke --projects=pi-apnea
```

Keep workflow behavior, protocol resources, briefs, and schemas in `@naxodev/apnea`. Keep Pi registration, Pi resources, and Pi-specific role launching in `@naxodev/pi-apnea`.

Both adapters must bind the shared operation registry. The Pi adapter must call it in process rather than invoke the CLI.

Compatible core patches flow through the Pi package's dependency range. Incompatible host interface changes require coordinated releases of both packages.
