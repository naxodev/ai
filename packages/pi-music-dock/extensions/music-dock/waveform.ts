/** Pure Tokyonight waveform: engine state + injected time → footer-safe ANSI. */

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

function hashSeed(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function clamp01(n: number): number {
	return n < 0 ? 0 : n > 1 ? 1 : n;
}

function fract(n: number): number {
	return n - Math.floor(n);
}

/** Map amplitude to Tokyonight blue; paused-low uses fixed subdued hex (no Pi theme). */
function blueFor(amp: number, playing: boolean): string {
	if (!playing && amp < 0.05) return "#565f89";
	if (amp <= 0.02) return BLUE[1]!;
	const idx = Math.min(BLUE.length - 1, Math.floor(amp * (BLUE.length - 1)));
	return BLUE[Math.max(2, idx)]!;
}

/** Soft multi-band targets — restrained motion. */
function targets(n: number, tSec: number, seed: number): Float64Array {
	const out = new Float64Array(n);
	const bpm = 96 + (seed % 28);
	const beat = ((tSec * bpm) / 60) * Math.PI * 2;
	const kick = Math.max(0, Math.sin(beat)) ** 10;
	const pulse = 0.5 + 0.5 * Math.sin(beat * 2 + 0.3);

	for (let i = 0; i < n; i++) {
		const x = n === 1 ? 0 : i / (n - 1);
		// Gentle EQ curve: a bit more energy on the left
		const shape = 0.55 + 0.45 * Math.exp(-x * 1.8);
		const wobble =
			0.55 * Math.sin(tSec * 1.6 + i * 0.48 + seed * 0.01) +
			0.3 * Math.sin(tSec * 2.9 + i * 0.9) +
			0.15 * Math.sin(tSec * 5.1 + i * 0.2);
		const grain = fract(
			Math.sin(i * 9.1 + Math.floor(tSec * 6) * 17.3 + seed) * 43758.5,
		);

		const v =
			shape *
			(0.32 + 0.28 * kick + 0.22 * pulse + 0.18 * (0.5 + 0.5 * wobble)) *
			(0.82 + 0.18 * grain);

		out[i] = clamp01(v);
	}

	// light blur for a clean silhouette
	const blur = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const l = out[i - 1] ?? out[i]!;
		const c = out[i]!;
		const r = out[i + 1] ?? out[i]!;
		blur[i] = l * 0.2 + c * 0.6 + r * 0.2;
	}
	return blur;
}

export type WaveEngine = {
	n: number;
	levels: Float64Array;
	seed: number;
	lastMs: number;
};

/** Advance levels toward targets (or decay when paused); all time is injected. */
export function stepEngine(
	eng: WaveEngine,
	tMs: number,
	playing: boolean,
	now: number,
): void {
	const dt = eng.lastMs ? Math.min(0.05, (now - eng.lastMs) / 1000) : 0.016;
	eng.lastMs = now;

	if (!playing) {
		for (let i = 0; i < eng.n; i++) {
			eng.levels[i] = Math.max(0, eng.levels[i]! * Math.exp(-dt * 5));
		}
		return;
	}

	const tgt = targets(eng.n, tMs / 1000, eng.seed);
	const attack = 1 - Math.exp(-dt * 18);
	const release = 1 - Math.exp(-dt * 5);
	for (let i = 0; i < eng.n; i++) {
		const cur = eng.levels[i]!;
		const want = tgt[i]!;
		const a = want > cur ? attack : release;
		eng.levels[i] = cur + (want - cur) * a;
	}
}

function blockChar(amp: number): string {
	return BLOCK[Math.max(0, Math.min(8, Math.round(amp * 8)))]!;
}

/** Fresh engine for `bars` cells; seed derives from the track key so each track moves differently. */
export function createEngine(bars: number, seedKey: string): WaveEngine {
	return {
		n: bars,
		levels: new Float64Array(bars),
		seed: hashSeed(seedKey || "idle"),
		lastMs: 0,
	};
}

/** True when every level has decayed below eps — Phase 3 stops the animation timer on this. */
export function isFlat(eng: WaveEngine, eps = 0.01): boolean {
	for (let i = 0; i < eng.n; i++) {
		if ((eng.levels[i] ?? 0) >= eps) return false;
	}
	return true;
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
