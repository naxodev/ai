import { describe, expect, test } from "bun:test";
import { createEngine, stepEngine, type WaveEngine } from "@naxodev/music-core";
import { renderWave } from "../extensions/music-dock/waveform.ts";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Advance the engine `steps` times at 50 ms per step (dt cap in stepEngine is 0.05 s). Continues from eng.lastMs so multi-phase drives keep monotonic wall time. */
function drive(
	eng: WaveEngine,
	opts: { steps: number; playing: boolean; startMs?: number },
): number {
	let now = opts.startMs ?? eng.lastMs ?? 0;
	// tMs tracks animation phase; keep it aligned with wall when continuing.
	let tMs = now;
	for (let i = 0; i < opts.steps; i++) {
		tMs += 50;
		now += 50;
		stepEngine(eng, tMs, opts.playing, now);
	}
	return tMs;
}

describe("renderWave", () => {
	// Footer line must not overflow the terminal — visible width equals bar count.
	test("visible width equals bar count in every state", () => {
		for (const bars of [16, 48]) {
			const eng = createEngine(bars, "width-check");
			expect([...stripAnsi(renderWave(eng, true))].length).toBe(bars);
			expect([...stripAnsi(renderWave(eng, false))].length).toBe(bars);

			drive(eng, { steps: 30, playing: true });
			expect([...stripAnsi(renderWave(eng, true))].length).toBe(bars);

			drive(eng, { steps: 10, playing: false });
			expect([...stripAnsi(renderWave(eng, false))].length).toBe(bars);
		}
	});

	// jj-footer sanitizeStatusText collapses plain-space runs and strips newlines/tabs.
	test("survives sanitizeStatusText — no spaces, newlines, or tabs", () => {
		const eng = createEngine(16, "sanitize");
		const playingOut = renderWave(eng, true);
		drive(eng, { steps: 30, playing: true });
		const midPlay = renderWave(eng, true);
		drive(eng, { steps: 8, playing: false });
		const midDecay = renderWave(eng, false);
		drive(eng, { steps: 24, playing: false });
		const flatOut = renderWave(eng, false);

		for (const out of [playingOut, midPlay, midDecay, flatOut]) {
			expect(out).not.toMatch(/\n/);
			expect(out).not.toMatch(/\t/);
			expect(out).not.toMatch(/ {2}/);
			expect(stripAnsi(out)).not.toMatch(/ /);
		}
	});
});

describe("ANSI determinism", () => {
	// Stable footer rendering requires identical drive → identical ANSI (Pi presentation).
	test("same seed + same drive yields byte-identical output; different seed differs", () => {
		const a = createEngine(16, "same-track");
		const b = createEngine(16, "same-track");
		const c = createEngine(16, "other-track");

		const seq: { tMs: number; playing: boolean; now: number }[] = [];
		let t = 0;
		for (let i = 0; i < 20; i++) {
			t += 50;
			seq.push({ tMs: t, playing: true, now: t });
		}

		for (const s of seq) {
			stepEngine(a, s.tMs, s.playing, s.now);
			stepEngine(b, s.tMs, s.playing, s.now);
			stepEngine(c, s.tMs, s.playing, s.now);
		}

		// Compare while still playing — fully decayed flat baselines look identical across seeds.
		const ra = renderWave(a, true);
		const rb = renderWave(b, true);
		const rc = renderWave(c, true);
		expect(ra).toBe(rb);
		expect(ra).not.toBe(rc);
	});
});
