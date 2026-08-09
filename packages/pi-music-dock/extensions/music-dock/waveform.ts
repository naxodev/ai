/** Pi footer-safe ANSI presentation for the shared core waveform engine. */

import type { WaveEngine } from "@naxodev/music-core";

export type { WaveEngine } from "@naxodev/music-core";

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

/** Map amplitude to Tokyonight blue; paused-low uses fixed subdued hex (no Pi theme). */
function blueFor(amp: number, playing: boolean): string {
	if (!playing && amp < 0.05) return "#565f89";
	if (amp <= 0.02) return BLUE[1]!;
	const idx = Math.min(BLUE.length - 1, Math.floor(amp * (BLUE.length - 1)));
	return BLUE[Math.max(2, idx)]!;
}

function blockChar(amp: number): string {
	return BLOCK[Math.max(0, Math.min(8, Math.round(amp * 8)))]!;
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
		const amp = eng.levels[i] ?? 0;
		// paused: flat low baseline
		const a = playing ? amp : amp > 0.02 ? amp * 0.4 : i % 4 === 0 ? 0.12 : 0;
		let ch = blockChar(a);
		let fg = blueFor(a, playing || a > 0.05);
		// Never emit plain space — jj-footer sanitizeStatusText collapses space runs.
		if (ch === " ") {
			ch = "▁";
			fg = BLUE[1]!;
		}
		out += ansiFg(fg) + ch;
	}
	return out + "\x1b[0m";
}
