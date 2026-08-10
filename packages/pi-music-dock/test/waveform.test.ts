import { describe, expect, test } from "bun:test";
import {
	createEngine,
	stepEngine,
	type WaveEngine,
	type WaveFrame,
} from "@naxodev/music-core";
import {
	createWaveformCoordinator,
	renderWave,
} from "../extensions/music-dock/waveform.ts";
import type { PlayerState } from "@naxodev/music-core";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function player(overrides: Partial<PlayerState> = {}): PlayerState {
	return {
		is_playing: true,
		progress_ms: 1_000,
		shuffle: false,
		repeat: "off",
		device: null,
		track: {
			id: "track-a",
			uri: "track-a",
			name: "Track A",
			artists: "Artist",
			album: "Album",
			duration_ms: 180_000,
		},
		fetched_at: 10_000,
		...overrides,
	};
}

function fakeScheduler() {
	let next = 0;
	const callbacks = new Map<number, () => void>();
	const created: number[] = [];
	const cleared: number[] = [];
	return {
		created,
		cleared,
		setInterval(callback: () => void) {
			const id = next++;
			created.push(id);
			callbacks.set(id, callback);
			return id;
		},
		clearInterval(id: unknown) {
			cleared.push(id as number);
			callbacks.delete(id as number);
		},
		run() {
			for (const callback of [...callbacks.values()]) callback();
		},
	};
}

/** Advance the engine `steps` times at 50 ms per step (dt cap in stepEngine is 0.05 s). Continues from eng.lastMs so multi-phase drives keep monotonic wall time. */
function drive(
	eng: WaveEngine,
	opts: { steps: number; playing: boolean; startMs?: number },
): number {
	let now = opts.startMs ?? eng.last_ms ?? 0;
	// tMs tracks animation phase; keep it aligned with wall when continuing.
	let tMs = now;
	for (let i = 0; i < opts.steps; i++) {
		tMs += 50;
		now += 50;
		stepEngine(eng, {
			track_key: "drive",
			bars: eng.n,
			progress_ms: tMs,
			fetched_at: now,
			is_playing: opts.playing,
			duration_ms: 0,
			now_ms: now,
		});
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

		const seq: WaveFrame[] = [];
		let t = 0;
		for (let i = 0; i < 20; i++) {
			t += 50;
			seq.push({
				track_key: "same-track",
				bars: 16,
				progress_ms: t,
				fetched_at: t,
				is_playing: true,
				duration_ms: 0,
				now_ms: t,
			});
		}

		for (const s of seq) {
			stepEngine(a, s);
			stepEngine(b, s);
			stepEngine(c, { ...s, track_key: "other-track" });
		}

		// Compare while still playing — fully decayed flat baselines look identical across seeds.
		const ra = renderWave(a, true);
		const rb = renderWave(b, true);
		const rc = renderWave(c, true);
		expect(ra).toBe(rb);
		expect(ra).not.toBe(rc);
	});
});

describe("Pi waveform lifecycle", () => {
	test("creates one timer, advances once, and clears it after pause settles", () => {
		let now = 10_000;
		const scheduler = fakeScheduler();
		const frames: Array<{ phase: number; stable: boolean }> = [];
		const coordinator = createWaveformCoordinator({
			now: () => now,
			scheduler,
			render: (_player, engine) =>
				frames.push({ phase: engine.phase_ms, stable: engine.paused_stable }),
		});

		coordinator.setPlayer(player());
		coordinator.frame();
		expect(scheduler.created).toHaveLength(1);
		now += 100;
		scheduler.run();
		expect(frames.at(-1)!.phase).toBe(1_100);

		coordinator.setPlayer(player({ is_playing: false }));
		coordinator.frame();
		expect(scheduler.cleared).toHaveLength(0);
		for (let i = 0; i < 30; i++) {
			now += 100;
			scheduler.run();
		}
		expect(frames.at(-1)!.stable).toBe(true);
		expect(scheduler.cleared).toEqual([0]);
	});

	test("starts immediately on resume and does not double-count consecutive corrections", () => {
		let now = 10_000;
		const scheduler = fakeScheduler();
		const phases: number[] = [];
		const coordinator = createWaveformCoordinator({
			now: () => now,
			scheduler,
			render: (_player, engine) => phases.push(engine.phase_ms),
		});
		coordinator.setPlayer(player({ is_playing: false }));
		coordinator.frame();
		coordinator.setPlayer(player());
		coordinator.start();
		expect(scheduler.created).toHaveLength(1);
		coordinator.frame();
		now = 10_100;
		coordinator.setPlayer(player({ progress_ms: 1_600, fetched_at: now }));
		coordinator.frame();
		now = 10_200;
		coordinator.setPlayer(player({ progress_ms: 1_700, fetched_at: now }));
		coordinator.frame();
		expect(phases.at(-1)).toBe(1_200);
	});

	test("resets before rendering a replacement, applies explicit seeks, and disposes", () => {
		let now = 10_000;
		const scheduler = fakeScheduler();
		const frames: Array<{ key: string; phase: number }> = [];
		const coordinator = createWaveformCoordinator({
			now: () => now,
			scheduler,
			render: (_player, engine) =>
				frames.push({ key: engine.track_key, phase: engine.phase_ms }),
		});
		coordinator.setPlayer(player());
		coordinator.frame();
		now = 10_100;
		coordinator.setPlayer(player({ progress_ms: 9_000, fetched_at: now }));
		coordinator.frame(true);
		expect(frames.at(-1)!.phase).toBe(9_000);
		now = 10_200;
		coordinator.setPlayer(player({ progress_ms: 500, fetched_at: now }));
		coordinator.frame(true);
		expect(frames.at(-1)!.phase).toBe(500);
		now = 10_300;
		coordinator.setPlayer(
			player({
				progress_ms: 50,
				fetched_at: now,
				track: { ...player().track!, id: "track-b", name: "Track B" },
			}),
		);
		coordinator.frame();
		expect(frames.at(-1)).toEqual({
			key: "Track B",
			phase: 50,
		});
		coordinator.dispose();
		expect(scheduler.cleared).toEqual([0]);
	});

	test("clears waveform state across a no-track gap before the same key returns", () => {
		let now = 10_000;
		const scheduler = fakeScheduler();
		const frames: number[] = [];
		const coordinator = createWaveformCoordinator({
			now: () => now,
			scheduler,
			render: (_player, engine) => frames.push(engine.phase_ms),
		});

		coordinator.setPlayer(player());
		coordinator.frame();
		now = 10_100;
		scheduler.run();
		expect(frames.at(-1)).toBe(1_100);
		coordinator.setPlayer(null);
		expect(coordinator.frame()).toBeNull();
		expect(scheduler.cleared).toEqual([0]);
		now = 10_200;
		coordinator.setPlayer(player({ progress_ms: 50, fetched_at: now }));
		coordinator.frame();
		expect(frames.at(-1)).toBe(50);
	});

	test("keeps waveform state when provider metadata is enriched", () => {
		let now = 10_000;
		const scheduler = fakeScheduler();
		const phases: number[] = [];
		const coordinator = createWaveformCoordinator({
			now: () => now,
			scheduler,
			render: (_player, engine) => phases.push(engine.phase_ms),
		});
		coordinator.setPlayer(
			player({ track: { ...player().track!, artists: "" } }),
		);
		coordinator.frame();
		now = 10_100;
		coordinator.setPlayer(player());
		coordinator.frame();
		expect(phases.at(-1)).toBe(1_100);
	});

	test("preserves a settled pause through enrichment and resets on one-field conflict", () => {
		let now = 10_000;
		const scheduler = fakeScheduler();
		const frames: Array<{ key: string; phase: number; levels: number[] }> = [];
		const coordinator = createWaveformCoordinator({
			now: () => now,
			scheduler,
			render: (_player, engine) =>
				frames.push({
					key: engine.track_key,
					phase: engine.phase_ms,
					levels: [...engine.levels],
				}),
		});
		coordinator.setPlayer(
			player({
				is_playing: false,
				progress_ms: 4_000,
				track: { ...player().track!, artists: "" },
			}),
		);
		coordinator.frame();
		const pausedLevels = frames.at(-1)!.levels;

		now = 10_100;
		coordinator.setPlayer(player({ is_playing: false, progress_ms: 4_000 }));
		coordinator.frame();
		expect(frames.at(-1)!.phase).toBe(4_000);
		expect(frames.at(-1)!.levels).toEqual(pausedLevels);

		coordinator.setPlayer(
			player({
				is_playing: false,
				progress_ms: 50,
				fetched_at: now,
				track: { ...player().track!, name: "Replacement", artists: "" },
			}),
		);
		coordinator.frame();
		expect(frames.at(-1)).toMatchObject({
			key: "Replacement",
			phase: 50,
		});
	});
});
