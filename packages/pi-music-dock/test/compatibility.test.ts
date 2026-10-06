import { expect, test } from "bun:test";
import manifest from "../package.json";

const piPackages = [
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
] as const;

test.each([
	["0.83.0", true],
	["0.84.2", true],
	["0.85.0", false],
	["0.87.1", true],
	["0.87.2", false],
	["1.0.0", true],
	["1.0.4", true],
	["1.1.0", true],
	["1.0.0-beta.1", false],
	["2.0.0", false],
])("declared peer ranges handle Pi %s", (version, supported) => {
	// Retain existing hosts, admit stable v1 updates, and fence the next breaking major.
	for (const name of piPackages)
		expect(Bun.semver.satisfies(version, manifest.peerDependencies[name])).toBe(
			supported,
		);
});

test("development host packages stay on the same supported exact v1 pin", () => {
	const agent = manifest.devDependencies[piPackages[0]];
	const tui = manifest.devDependencies[piPackages[1]];
	expect(agent).toBe(tui);
	expect(agent).toMatch(/^1\.\d+\.\d+$/);
	for (const name of piPackages)
		expect(
			Bun.semver.satisfies(
				manifest.devDependencies[name],
				manifest.peerDependencies[name],
			),
		).toBe(true);
});
