import { describe, expect, test } from "bun:test";
import { clipWords, formatMs } from "../extensions/music-dock/format.ts";

describe("clipWords", () => {
	// Short titles must pass through unchanged so the footer stays readable.
	test("three words under max stay unchanged (trimmed)", () => {
		expect(clipWords("one two three", 6)).toBe("one two three");
		expect(clipWords("  one two three  ", 6)).toBe("one two three");
	});

	// Title must fit a one-line footer.
	test("seven-plus words become first 6 + ellipsis, no trailing space", () => {
		expect(clipWords("one two three four five six seven", 6)).toBe(
			"one two three four five six…",
		);
	});

	// Whitespace runs must not produce empty words when the clip path joins.
	test("whitespace runs collapse via \\s+ split", () => {
		expect(clipWords("a\t b\n c d e f g h", 6)).toBe("a b c d e f…");
	});

	// Artists lists clip the same way at a tighter max.
	test("max=4 clips artists lists", () => {
		expect(clipWords("Alice Bob Carol Dave Eve", 4)).toBe(
			"Alice Bob Carol Dave…",
		);
	});
});

describe("formatMs", () => {
	// Progress/duration display in footer must be m:ss and clamp negatives.
	test("formats seconds and clamps negatives to 0:00", () => {
		expect(formatMs(65_000)).toBe("1:05");
		expect(formatMs(-1)).toBe("0:00");
	});
});
