/** Deep rendering module for the Pi music side panel overlay. */

import type { PlayerState, WaveEngine } from "@naxodev/music-core";
import { formatMs, livePlaybackPosition } from "@naxodev/music-core";
import {
	deleteKittyImage,
	getCellDimensions,
	getImageDimensions,
	Image,
	matchesKey,
	Key,
	truncateToWidth,
	visibleWidth,
	type Component,
	type ImageDimensions,
} from "@earendil-works/pi-tui";
import type { ArtworkPresentation } from "./artwork.ts";
import { renderWave } from "./waveform.ts";

export type SidebarTheme = {
	fg: (color: string, text: string) => string;
	bold?: (text: string) => string;
};

export type MusicSidebarState = {
	player: PlayerState | null;
	engine: WaveEngine | null;
	artwork: ArtworkPresentation;
	focused: boolean;
	hiddenByUser: boolean;
};

export type MusicSidebarHandlers = {
	onTogglePlayback: () => void;
	onNext: () => void;
	onPrevious: () => void;
	onUnfocus: () => void;
	onChange?: () => void;
};

/** Injected TUI surface: redraw + optional terminal writes for Kitty cleanup. */
export type SidebarTui = {
	requestRender: () => void;
	terminal?: { write: (data: string) => void };
};

export type MusicSidebarOptions = {
	now?: () => number;
};

export type MusicSidebar = Component & {
	update: (patch: Partial<MusicSidebarState>) => void;
	getState: () => MusicSidebarState;
	/** Test/debug: current image ownership key, or undefined when none. */
	getImageKey: () => string | undefined;
	dispose: () => void;
};

type ImageTheme = {
	fallbackColor: (str: string) => string;
};

const EMPTY_ARTWORK: ArtworkPresentation = { kind: "empty" };
const ARTWORK_ROWS = 8;
const ARTWORK_MAX_COLUMNS = 16;

/**
 * Exact ownership key for a ready artwork payload.
 * Full base64 (not a prefix) so same-format/same-size covers cannot collide.
 */
export function artworkImageKey(mime: string, base64: string): string {
	return `${mime}\0${base64}`;
}

function clip(text: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, "…");
}

function pad(text: string, width: number): string {
	const visible = visibleWidth(text);
	if (visible >= width) return clip(text, width);
	return text + " ".repeat(width - visible);
}

function progressBar(ratio: number, width: number): string {
	if (width <= 0) return "";
	const filled = Math.max(
		0,
		Math.min(width, Math.round(Math.max(0, Math.min(1, ratio)) * width)),
	);
	return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function borderLine(left: string, fill: string, right: string, inner: number) {
	return `${left}${fill.repeat(Math.max(0, inner))}${right}`;
}

function imageColumns(dimensions: ImageDimensions, inner: number): number {
	const maxWidth = Math.max(
		1,
		Math.min(ARTWORK_MAX_COLUMNS, Math.max(1, inner - 2)),
	);
	const cells = getCellDimensions();
	const widthScale =
		(maxWidth * cells.widthPx) / Math.max(1, dimensions.widthPx);
	const heightScale =
		(ARTWORK_ROWS * cells.heightPx) / Math.max(1, dimensions.heightPx);
	const scale = Math.min(widthScale, heightScale);
	return Math.max(
		1,
		Math.min(maxWidth, Math.ceil((dimensions.widthPx * scale) / cells.widthPx)),
	);
}

/**
 * Create a self-contained side panel component.
 * Host code pushes player/artwork/focus updates; the panel owns image lifecycle.
 */
export function createMusicSidebar(
	tui: SidebarTui,
	theme: SidebarTheme,
	handlers: MusicSidebarHandlers,
	options: MusicSidebarOptions = {},
): MusicSidebar {
	const now = options.now ?? Date.now;
	let state: MusicSidebarState = {
		player: null,
		engine: null,
		artwork: EMPTY_ARTWORK,
		focused: false,
		hiddenByUser: false,
	};
	let image: Image | null = null;
	let imageDimensions: ImageDimensions | null = null;
	let imageKey: string | undefined;
	let disposed = false;
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;

	const imageTheme: ImageTheme = {
		fallbackColor: (str) => theme.fg("dim", str),
	};

	const invalidate = () => {
		cachedWidth = undefined;
		cachedLines = undefined;
	};

	const disposeImage = () => {
		if (!image) return;
		const id = image.getImageId?.();
		if (typeof id === "number") {
			// Kitty delete goes through the TUI terminal so Pi owns the write path.
			// Tests inject a fake terminal (or none) and see no process.stdout noise.
			try {
				tui.terminal?.write(deleteKittyImage(id));
			} catch {
				// ignore write failures during teardown
			}
			try {
				tui.requestRender();
			} catch {
				// ignore
			}
		}
		image = null;
		imageDimensions = null;
		imageKey = undefined;
	};

	const syncImage = () => {
		if (state.artwork.kind !== "ready") {
			disposeImage();
			return;
		}
		const { base64, mime } = state.artwork.artwork;
		const key = artworkImageKey(mime, base64);
		if (image && imageKey === key) return;
		disposeImage();
		imageDimensions = getImageDimensions(base64, mime);
		image = new Image(base64, mime, imageTheme, {
			maxWidthCells: ARTWORK_MAX_COLUMNS,
			maxHeightCells: ARTWORK_ROWS,
			filename: "artwork",
		});
		imageKey = key;
	};

	const update = (patch: Partial<MusicSidebarState>) => {
		if (disposed) return;
		const next = { ...state, ...patch };
		const artworkChanged = patch.artwork !== undefined;
		const playerChanged = patch.player !== undefined;
		const engineChanged = patch.engine !== undefined;
		const focusChanged = patch.focused !== undefined;
		state = next;
		if (artworkChanged) syncImage();
		if (
			artworkChanged ||
			playerChanged ||
			engineChanged ||
			focusChanged ||
			patch.hiddenByUser !== undefined
		) {
			invalidate();
			handlers.onChange?.();
		}
	};

	const handleInput = (data: string) => {
		if (disposed || !state.focused) return;
		if (matchesKey(data, Key.escape)) {
			handlers.onUnfocus();
			return;
		}
		if (matchesKey(data, Key.space)) {
			handlers.onTogglePlayback();
			return;
		}
		if (matchesKey(data, Key.left)) {
			handlers.onPrevious();
			return;
		}
		if (matchesKey(data, Key.right)) {
			handlers.onNext();
		}
	};

	const liveProgressMs = (): number => {
		const current = state.player;
		const track = current?.track;
		if (!current || !track) return 0;
		return livePlaybackPosition({
			track_key: track.id || track.uri || track.name,
			bars: 1,
			progress_ms: current.progress_ms,
			fetched_at: current.fetched_at,
			is_playing: current.is_playing,
			duration_ms: track.duration_ms,
			now_ms: now(),
		});
	};

	const renderArtwork = (inner: number): string[] => {
		const reserveSlot = (lines: string[]) => {
			const reserved = lines.slice(0, ARTWORK_ROWS);
			while (reserved.length < ARTWORK_ROWS) reserved.push("");
			return reserved;
		};
		const placeholder = (label: string) => {
			const lines = Array.from({ length: ARTWORK_ROWS }, () => "");
			const text = clip(`[ ${label} ]`, inner);
			const left = Math.max(0, Math.floor((inner - visibleWidth(text)) / 2));
			lines[Math.floor(ARTWORK_ROWS / 2)] =
				" ".repeat(left) + theme.fg("dim", text);
			return lines;
		};
		if (state.artwork.kind === "loading") return placeholder("loading art");
		if (state.artwork.kind === "unavailable") return placeholder("no artwork");
		if (state.artwork.kind === "unsupported")
			return placeholder("unsupported image");
		if (state.artwork.kind !== "ready" || !image)
			return placeholder("no artwork");
		const columns = imageDimensions
			? imageColumns(imageDimensions, inner)
			: Math.min(ARTWORK_MAX_COLUMNS, inner);
		const left = Math.max(0, Math.floor((inner - columns) / 2));
		const lines = image.render(inner).map((line) => {
			const width = visibleWidth(line);
			if (width === 0 && line.length > 0) return " ".repeat(left) + line;
			if (width > inner) return clip(line, inner);
			return " ".repeat(Math.max(0, Math.floor((inner - width) / 2))) + line;
		});
		return reserveSlot(lines);
	};

	const renderBody = (width: number): string[] => {
		const inner = Math.max(1, width - 2);
		const border = (ch: string) => theme.fg("border", ch);
		const line = (content: string) =>
			border("│") + pad(content, inner) + border("│");
		const lines: string[] = [];

		lines.push(border(borderLine("╭", "─", "╮", inner)));
		const title = theme.fg(
			"accent",
			state.focused ? " Music · focused" : " Music",
		);
		lines.push(line(title));
		lines.push(border(borderLine("├", "─", "┤", inner)));

		for (const artLine of renderArtwork(inner)) lines.push(line(artLine));
		lines.push(line(""));

		const track = state.player?.track;
		if (track) {
			const playing = state.player?.is_playing ?? false;
			const icon = playing ? "▶" : "⏸";
			const status = theme.fg(
				playing ? "success" : "muted",
				` ${icon} ${playing ? "Playing" : "Paused"}`,
			);
			lines.push(line(status));
			lines.push(
				line(theme.fg("text", ` ${clip(track.name, Math.max(1, inner - 1))}`)),
			);
			lines.push(
				line(
					theme.fg("muted", ` ${clip(track.artists, Math.max(1, inner - 1))}`),
				),
			);
			if (track.album) {
				lines.push(
					line(
						theme.fg("dim", ` ${clip(track.album, Math.max(1, inner - 1))}`),
					),
				);
			}

			if (state.engine) {
				const wave = renderWave(state.engine, playing);
				// Wave is fixed engine width; clip if the panel is narrower.
				lines.push(line(` ${clip(wave, Math.max(1, inner - 1))}`));
				lines.push(line(""));
			}

			const duration = Math.max(0, track.duration_ms);
			const progress = Math.max(0, liveProgressMs());
			const ratio = duration > 0 ? progress / duration : 0;
			const time = `${formatMs(progress)} / ${formatMs(duration)}`;
			const timeWidth = visibleWidth(time);
			const barWidth = Math.max(0, inner - 1 - timeWidth - 1);
			const bar = progressBar(ratio, barWidth);
			lines.push(
				line(
					` ${theme.fg("dim", bar)}${barWidth > 0 ? " " : ""}${theme.fg("muted", time)}`,
				),
			);
		} else {
			lines.push(line(theme.fg("dim", " No track playing")));
		}

		lines.push(border(borderLine("├", "─", "┤", inner)));
		if (state.focused) {
			lines.push(line(theme.fg("dim", " Space play/pause")));
			lines.push(line(theme.fg("dim", " ← prev  → next")));
			lines.push(line(theme.fg("dim", " Esc unfocus")));
		} else {
			lines.push(line(theme.fg("dim", " /music-focus focus")));
			lines.push(line(theme.fg("dim", " /music-view hide")));
			lines.push(line(theme.fg("dim", " ctrl+alt+m toggle")));
		}
		lines.push(border(borderLine("╰", "─", "╯", inner)));

		return lines.map((entry) => {
			// Final width fence: every returned line must fit the overlay slot.
			if (visibleWidth(entry) > width) return clip(entry, width);
			return entry;
		});
	};

	return {
		update,
		getState: () => state,
		getImageKey: () => imageKey,
		handleInput,
		invalidate,
		render: (width: number) => {
			// While playing, skip the width cache so live progress advances with now().
			const playing = Boolean(state.player?.is_playing && state.player.track);
			if (!playing && cachedLines && cachedWidth === width) return cachedLines;
			const lines = renderBody(Math.max(1, width));
			cachedWidth = width;
			cachedLines = lines;
			return lines;
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			disposeImage();
			state = {
				player: null,
				engine: null,
				artwork: EMPTY_ARTWORK,
				focused: false,
				hiddenByUser: state.hiddenByUser,
			};
			invalidate();
		},
	};
}
