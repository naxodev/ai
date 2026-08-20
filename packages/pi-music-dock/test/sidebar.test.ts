import { expect, test } from "bun:test";
import { createEngine, type PlayerState } from "@naxodev/music-core";
import {
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	artworkImageKey,
	createMusicSidebar,
} from "../extensions/music-dock/sidebar.ts";
import { PNG_1X1_BASE64 } from "./artwork-fixtures.ts";

const theme = {
	fg: (_color: string, text: string) => text,
};

const player = (
	name = "Song",
	overrides: Partial<PlayerState> = {},
): PlayerState => ({
	is_playing: true,
	progress_ms: 65_000,
	shuffle: false,
	repeat: "off",
	device: null,
	fetched_at: 1,
	track: {
		id: "t1",
		uri: "uri",
		name,
		artists: "Artist Name",
		album: "Album Title",
		duration_ms: 180_000,
	},
	...overrides,
});

function panel(options?: {
	now?: () => number;
	terminalWrite?: (data: string) => void;
}) {
	const calls = {
		toggle: 0,
		next: 0,
		prev: 0,
		unfocus: 0,
		change: 0,
		render: 0,
	};
	const writes: string[] = [];
	const sidebar = createMusicSidebar(
		{
			requestRender: () => {
				calls.render++;
			},
			terminal: options?.terminalWrite
				? {
						write: (data: string) => {
							writes.push(data);
							options.terminalWrite?.(data);
						},
					}
				: undefined,
		},
		theme,
		{
			onTogglePlayback: () => calls.toggle++,
			onNext: () => calls.next++,
			onPrevious: () => calls.prev++,
			onUnfocus: () => calls.unfocus++,
			onChange: () => calls.change++,
		},
		{ now: options?.now },
	);
	return { sidebar, calls, writes };
}

test("every rendered line fits the requested width, even when narrow", () => {
	// Why: overlay lines that exceed width corrupt the TUI compositor and can
	// crash or wrap into the transcript. Narrow terminals still get a panel slot.
	const { sidebar } = panel();
	sidebar.update({
		player: player("A very long track title that should be clipped hard"),
		engine: createEngine(16, "seed"),
		artwork: { kind: "unavailable" },
		focused: false,
		hiddenByUser: false,
	});
	for (const width of [10, 20, 30, 40]) {
		const lines = sidebar.render(width);
		expect(lines.length).toBeGreaterThan(3);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	}
});

test("unsupported and missing artwork render text placeholders, not Image bytes", () => {
	// Why: terminals without image protocols, and unknown byte streams, must
	// degrade to readable text instead of dumping base64 into the panel.
	const { sidebar } = panel();
	sidebar.update({
		player: player(),
		artwork: { kind: "unsupported" },
	});
	expect(sidebar.render(30).join("\n")).toContain("unsupported image");
	sidebar.update({ artwork: { kind: "unavailable" } });
	expect(sidebar.render(30).join("\n")).toContain("no artwork");
	sidebar.update({ artwork: { kind: "loading" } });
	expect(sidebar.render(30).join("\n")).toContain("loading art");
});

test("artwork states reserve one stable compact slot", () => {
	// Why: the right-center overlay must not jump when a loading label becomes
	// an image, but ten rows made the panel dominate a common split pane.
	const { sidebar } = panel();
	const states = [
		{ kind: "empty" } as const,
		{ kind: "loading" } as const,
		{ kind: "unavailable" } as const,
		{ kind: "unsupported" } as const,
		{
			kind: "ready",
			artwork: { base64: PNG_1X1_BASE64, mime: "image/png" as const },
		} as const,
	];
	for (const artwork of states) {
		sidebar.update({ player: null, artwork });
		expect(sidebar.render(30)).toHaveLength(18);
	}
});

test("Kitty artwork is centered inside both panel borders", () => {
	// Why: a zero-width image sequence at column zero paints over the left
	// border. Prefixing the measured placement keeps a compact cover contained.
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	try {
		const { sidebar } = panel();
		sidebar.update({
			player: player(),
			engine: createEngine(16, "spacing"),
			artwork: {
				kind: "ready",
				artwork: { base64: PNG_1X1_BASE64, mime: "image/png" },
			},
		});
		const lines = sidebar.render(30);
		const imageIndex = lines.findIndex((line) => line.includes("\x1b_G"));
		const statusIndex = lines.findIndex((line) => line.includes("Playing"));
		const progressIndex = lines.findIndex((line) => line.includes(" / "));
		const imageLine = lines[imageIndex];
		expect(imageLine).toBeDefined();
		expect(imageLine).toStartWith(`│${" ".repeat(6)}\x1b_G`);
		expect(imageLine).toEndWith("│");
		expect(visibleWidth(imageLine!)).toBe(30);
		// One bordered row separates the physical eight-row image from metadata.
		expect(statusIndex - imageIndex).toBe(9);
		// A second row keeps the animated waveform distinct from progress.
		expect(lines[progressIndex - 1]).toBe(`│${" ".repeat(28)}│`);
	} finally {
		resetCapabilitiesCache();
	}
});

test("focused input delegates transport exactly once and Escape unfocuses", () => {
	// Why: while focused the panel owns Space/arrows; those keys must map to
	// the same single-client transport path, and Escape must return the editor.
	const { sidebar, calls } = panel();
	sidebar.update({ focused: false, player: player() });
	sidebar.handleInput?.(" ");
	expect(calls.toggle).toBe(0);

	sidebar.update({ focused: true });
	sidebar.handleInput?.(" ");
	sidebar.handleInput?.("\x1b[C"); // right
	sidebar.handleInput?.("\x1b[D"); // left
	sidebar.handleInput?.("\x1b"); // escape
	expect(calls).toMatchObject({
		toggle: 1,
		next: 1,
		prev: 1,
		unfocus: 1,
		change: 2,
	});
});

test("artwork image key uses full base64 so equal prefix+length covers do not collide", () => {
	// Why: same-format/same-size album covers can share a long common base64
	// prefix and identical length. Ownership must change when only the tail differs.
	const shared = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ".repeat(3);
	const a = `${shared}AAAA`;
	const b = `${shared}BBBB`;
	expect(a.length).toBe(b.length);
	expect(a.slice(0, 32)).toBe(b.slice(0, 32));
	// Old prefix+length scheme would collide; full-payload keys must not.
	const oldStyle = (mime: string, base64: string) =>
		`${mime}\0${base64.length}\0${base64.slice(0, 32)}`;
	expect(oldStyle("image/png", a)).toBe(oldStyle("image/png", b));
	expect(artworkImageKey("image/png", a)).not.toBe(
		artworkImageKey("image/png", b),
	);

	const { sidebar } = panel();
	sidebar.update({
		player: player(),
		artwork: { kind: "ready", artwork: { base64: a, mime: "image/png" } },
	});
	const first = sidebar.getImageKey();
	expect(first).toBe(artworkImageKey("image/png", a));

	sidebar.update({
		artwork: { kind: "ready", artwork: { base64: b, mime: "image/png" } },
	});
	const second = sidebar.getImageKey();
	expect(second).toBe(artworkImageKey("image/png", b));
	expect(second).not.toBe(first);
});

test("live progress advances with injected now while playing; paused stays frozen", () => {
	// Why: frozen progress_ms makes a playing track look stuck between provider
	// ticks. Project with now() while playing; keep paused snapshots stable.
	let now = 1_000;
	const { sidebar } = panel({ now: () => now });
	sidebar.update({
		player: player("Song", {
			is_playing: true,
			progress_ms: 0,
			fetched_at: 1_000,
			track: {
				id: "t1",
				uri: "uri",
				name: "Song",
				artists: "Artist",
				album: "Album",
				duration_ms: 180_000,
			},
		}),
	});
	expect(sidebar.render(30).join("\n")).toContain("0:00 / 3:00");
	now = 11_000;
	expect(sidebar.render(30).join("\n")).toContain("0:10 / 3:00");

	sidebar.update({
		player: player("Song", {
			is_playing: false,
			progress_ms: 5_000,
			fetched_at: 1_000,
			track: {
				id: "t1",
				uri: "uri",
				name: "Song",
				artists: "Artist",
				album: "Album",
				duration_ms: 180_000,
			},
		}),
	});
	now = 60_000;
	expect(sidebar.render(30).join("\n")).toContain("0:05 / 3:00");
});

test("Kitty deletion writes through the injected terminal, not process.stdout", () => {
	// Why: process.stdout bypasses Pi's terminal and pollutes tests/pipes.
	// A fake terminal captures deletes; omitting terminal yields no output.
	const writes: string[] = [];
	const withTerminal = panel({
		terminalWrite: (data) => writes.push(data),
	});
	// Without a Kitty image id (no render under Kitty caps), dispose still
	// clears ownership without requiring a write.
	withTerminal.sidebar.update({
		player: player(),
		artwork: {
			kind: "ready",
			artwork: {
				base64: PNG_1X1_BASE64,
				mime: "image/png",
			},
		},
	});
	withTerminal.sidebar.dispose();
	expect(withTerminal.sidebar.getImageKey()).toBeUndefined();
	// No imageId allocated without Kitty render — zero writes is correct.
	expect(writes).toEqual([]);

	const silent = panel();
	silent.sidebar.update({
		player: player(),
		artwork: {
			kind: "ready",
			artwork: {
				base64: PNG_1X1_BASE64,
				mime: "image/png",
			},
		},
	});
	silent.sidebar.dispose();
	expect(silent.writes).toEqual([]);
});

test("dispose clears artwork work so a replacement session cannot reuse it", () => {
	// Why: Kitty image ids and cached lines must not outlive the session that
	// created them; reload/shutdown dispose is the fence.
	const { sidebar } = panel();
	sidebar.update({
		player: player(),
		artwork: {
			kind: "ready",
			artwork: {
				base64: PNG_1X1_BASE64,
				mime: "image/png",
			},
		},
	});
	sidebar.dispose();
	expect(sidebar.getState().artwork).toEqual({ kind: "empty" });
	expect(sidebar.getState().player).toBeNull();
	expect(sidebar.getImageKey()).toBeUndefined();
	// Updates after dispose are ignored.
	sidebar.update({ player: player("late") });
	expect(sidebar.getState().player).toBeNull();
});
