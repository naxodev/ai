export {};

const expectedFiles = new Set([
	"CHANGELOG.md",
	"LICENSE",
	"README.md",
	"extensions/music-dock/artwork.ts",
	"extensions/music-dock/format.ts",
	"extensions/music-dock/index.ts",
	"extensions/music-dock/sidebar.ts",
	"extensions/music-dock/waveform.ts",
	"package.json",
]);

const child = Bun.spawn(["npm", "pack", "--dry-run", "--json"], {
	stdout: "pipe",
	stderr: "inherit",
});
const output = await new Response(child.stdout).text();
if ((await child.exited) !== 0) throw new Error("npm pack --dry-run failed");

const packs = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
const files = new Set(packs[0]?.files.map(({ path }) => path));

for (const expected of expectedFiles) {
	if (!files.has(expected))
		throw new Error(`npm package is missing ${expected}`);
}

for (const file of files) {
	if (!expectedFiles.has(file)) throw new Error(`npm package contains ${file}`);
}

console.log(`Verified npm package contents (${files.size} files)`);
