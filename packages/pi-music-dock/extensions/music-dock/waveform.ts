/** Pi footer-safe ANSI presentation for the shared core waveform engine. */

import {
	createEngine,
	displayLevel,
	isFlat,
	stepEngine,
	sameTrackIdentity,
	waveformSeedKey,
	type PlayerState,
	type WaveEngine,
} from "@naxodev/music-core";

export type { WaveEngine } from "@naxodev/music-core";

export type WaveformScheduler = {
	setInterval: (callback: () => void, ms: number) => unknown;
	clearInterval: (timer: unknown) => void;
};

type WaveformCoordinatorOptions = {
	now: () => number;
	scheduler: WaveformScheduler;
	render: (player: PlayerState, engine: WaveEngine) => void;
};

/** Pi-owned engine and animation lifecycle, with injectable clock and timers. */
export function createWaveformCoordinator(options: WaveformCoordinatorOptions) {
	let player: PlayerState | null = null;
	let engine: WaveEngine | null = null;
	let engineKey = "";
	let timer: unknown = null;

	const stop = () => {
		if (timer === null) return;
		options.scheduler.clearInterval(timer);
		timer = null;
	};

	const start = () => {
		if (timer !== null || !player?.track) return;
		timer = options.scheduler.setInterval(() => frame(), 100);
	};

	const frame = (seek = false) => {
		const track = player?.track;
		if (!player || !track) {
			stop();
			return null;
		}

		const key = engineKey || waveformSeedKey(track.name, track.id);
		if (!engine || engineKey !== key) {
			engine = createEngine(16, key);
			engineKey = key;
		}
		stepEngine(engine, {
			track_key: key,
			bars: 16,
			progress_ms: player.progress_ms,
			fetched_at: player.fetched_at,
			is_playing: player.is_playing,
			duration_ms: track.duration_ms,
			now_ms: options.now(),
			seek,
		});
		options.render(player, engine);
		if (player.is_playing) start();
		else if (isFlat(engine)) stop();
		else start();
		return engine;
	};

	return {
		setPlayer: (next: PlayerState | null) => {
			if (!next?.track) {
				player = null;
				engine = null;
				engineKey = "";
				stop();
				return;
			}
			if (player?.track && !sameTrackIdentity(player.track, next.track)) {
				engine = null;
				engineKey = "";
			}
			player = next;
		},
		frame,
		start,
		stop,
		dispose: () => {
			stop();
			player = null;
			engine = null;
			engineKey = "";
		},
	};
}

const BLOCK = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/** Tokyonight blue ramp — low energy → peak (no rainbow). */
const BLUE = [
	"#1a1b26", // void
	"#24283b", // surface
	"#3d59a1", // deep
	"#414868", // comment
	"#565f89", // dark blue-gray
	"#7aa2f7", // blue
	"#89b4fa", // soft blue
	"#b4c0f7", // pale
	"#c0caf5", // foreground flash
] as const;

/** Map visualization level to Tokyonight blue; paused-low uses a fixed subdued hex. */
function blueFor(level: number, playing: boolean): string {
	if (!playing && level < 0.05) return "#565f89";
	if (level <= 0.02) return BLUE[1]!;
	const idx = Math.min(BLUE.length - 1, Math.floor(level * (BLUE.length - 1)));
	return BLUE[Math.max(2, idx)]!;
}

function blockChar(level: number): string {
	return BLOCK[Math.max(0, Math.min(8, Math.round(level * 8)))]!;
}

/** Parse `#rrggbb` into a truecolor SGR foreground escape. */
function ansiFg(hex: string): string {
	const h = hex.startsWith("#") ? hex.slice(1) : hex;
	const r = parseInt(h.slice(0, 2), 16);
	const g = parseInt(h.slice(2, 4), 16);
	const b = parseInt(h.slice(4, 6), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** One footer-safe ANSI string, visible width exactly eng.n. */
export function renderWave(eng: WaveEngine, playing: boolean): string {
	let out = "";
	for (let i = 0; i < eng.n; i++) {
		const level = displayLevel(eng.levels[i] ?? 0, i, playing);
		let ch = blockChar(level);
		let fg = blueFor(level, playing || level > 0.05);
		// Never emit plain space — jj-footer sanitizeStatusText collapses space runs.
		if (ch === " ") {
			ch = "▁";
			fg = BLUE[1]!;
		}
		out += ansiFg(fg) + ch;
	}
	return out + "\x1b[0m";
}
