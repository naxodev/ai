import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const expectedCommands = ["music", "music-next", "music-prev"];
const createdArchive = process.argv[2] === undefined;
let archive = process.argv[2];

if (!archive) {
	const packed = Bun.spawnSync(["npm", "pack", "--silent"], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (!packed.success) {
		throw new Error(`npm pack failed: ${packed.stderr.toString()}`);
	}
	archive = packed.stdout.toString().trim().split("\n").at(-1);
}

if (!archive) throw new Error("npm pack did not produce an archive");
archive = resolve(archive);
const work = await mkdtemp(join(tmpdir(), "pi-music-dock-smoke-"));

try {
	const unpacked = Bun.spawnSync(["tar", "-xzf", archive, "-C", work], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (!unpacked.success) {
		throw new Error(
			`could not unpack ${basename(archive)}: ${unpacked.stderr}`,
		);
	}

	const packageDir = join(work, "package");
	const manifest = JSON.parse(
		await readFile(join(packageDir, "package.json"), "utf8"),
	) as {
		name?: string;
		pi?: { extensions?: string[] };
	};
	if (manifest.name !== "@naxodev/pi-music-dock") {
		throw new Error(`unexpected packed package name: ${manifest.name}`);
	}
	if (manifest.pi?.extensions?.join(",") !== "./extensions") {
		throw new Error("packed manifest does not expose ./extensions to Pi");
	}

	const pi = Bun.which("pi");
	if (!pi) throw new Error("could not resolve the Pi executable from PATH");
	const child = Bun.spawn(
		[
			pi,
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"-e",
			packageDir,
		],
		{
			cwd: work,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	child.stdin.write('{"type":"get_commands","id":"smoke"}\n');
	child.stdin.end();

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`Pi exited ${exitCode}: ${stderr}`);

	const response = stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.find((message) => message.id === "smoke");
	const data = response?.data as
		{ commands?: Array<{ name?: string; source?: string }> } | undefined;
	const commands = data?.commands?.filter(
		(command) => command.source === "extension",
	);
	for (const name of expectedCommands) {
		if (!commands?.some((command) => command.name === name)) {
			throw new Error(`Pi did not load /${name} from the packed package`);
		}
	}

	console.log(
		`Pi loaded ${basename(archive)} and registered all music commands.`,
	);
} finally {
	await rm(work, { recursive: true, force: true });
	if (createdArchive) await rm(archive, { force: true });
}
