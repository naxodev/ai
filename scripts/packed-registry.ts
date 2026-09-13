import { createHash } from "node:crypto"

/** Serve local packed packages; unrelated dependencies still use the public registry. */
export async function packedRegistry(archives: readonly string[]) {
  const packages = await Promise.all(
    archives.map(async (archive, index) => {
      const unpacked = Bun.spawnSync(
        ["tar", "-xOf", archive, "package/package.json"],
        { timeout: 10_000 },
      )
      if (!unpacked.success)
        throw new Error(`Cannot read packed manifest: ${archive}`)
      const manifest = JSON.parse(unpacked.stdout.toString()) as {
        name: string
        version: string
      }
      const bytes = await Bun.file(archive).arrayBuffer()
      return {
        manifest,
        archive,
        index,
        integrity: `sha512-${createHash("sha512").update(Buffer.from(bytes)).digest("base64")}`,
      }
    }),
  )
  const requests = new Set<string>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const path = decodeURIComponent(new URL(request.url).pathname).slice(1)
      const tarball = packages.find(
        (item) => path === `tarball/${item.index}.tgz`,
      )
      if (tarball) {
        requests.add(`tarball:${tarball.manifest.name}`)
        return new Response(Bun.file(tarball.archive))
      }
      const item = packages.find((item) => item.manifest.name === path)
      if (item) {
        requests.add(`metadata:${path}`)
        const { manifest } = item
        return Response.json({
          name: manifest.name,
          "dist-tags": { latest: manifest.version },
          versions: {
            [manifest.version]: {
              ...manifest,
              dist: {
                tarball: `${server.url}tarball/${item.index}.tgz`,
                integrity: item.integrity,
              },
            },
          },
        })
      }
      // Never resolve a workspace package to an older public release.
      if (path.startsWith("@naxodev/"))
        return new Response("Unknown fixture package", { status: 404 })
      const upstream = await fetch(
        `https://registry.npmjs.org/${new URL(request.url).pathname.slice(1)}`,
        { signal: AbortSignal.timeout(30_000) },
      )
      // Fetch decodes compression; do not forward the original encoding headers.
      return new Response(await upstream.arrayBuffer(), {
        status: upstream.status,
        headers: { "content-type": "application/json" },
      })
    },
  })
  return {
    url: server.url.href,
    assertInstalled(name: string) {
      if (!requests.has(`metadata:${name}`) || !requests.has(`tarball:${name}`))
        throw new Error(
          `Host did not resolve and download ${name} from the fixture registry`,
        )
    },
    stop: () => server.stop(true),
  }
}
