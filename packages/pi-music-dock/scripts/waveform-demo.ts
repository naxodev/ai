/**
 * Manual eyeball: generated waveform motion while playing, then a still baseline.
 * Run: bun scripts/waveform-demo.ts
 */
import { createEngine, isFlat, stepEngine } from "@naxodev/music-core";
import { renderWave } from "../extensions/music-dock/waveform.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const eng = createEngine(16, "demo");
const originMs = Date.now();
const tickMs = 64;

// Phase A — playing pulse (~2 s)
const playUntil = originMs + 2000;
while (Date.now() < playUntil) {
	const now = Date.now();
	stepEngine(eng, {
		track_key: "demo",
		bars: 16,
		progress_ms: 0,
		fetched_at: originMs,
		is_playing: true,
		duration_ms: 0,
		now_ms: now,
	});
	process.stdout.write("\r▶ " + renderWave(eng, true));
	await sleep(tickMs);
}

// Phase B — paused decay (~1.5 s)
const pauseStarted = Date.now();
const pauseUntil = pauseStarted + 1500;
while (Date.now() < pauseUntil) {
	const now = Date.now();
	stepEngine(eng, {
		track_key: "demo",
		bars: 16,
		progress_ms: now - originMs,
		fetched_at: pauseStarted,
		is_playing: false,
		duration_ms: 0,
		now_ms: now,
	});
	process.stdout.write("\r⏸ " + renderWave(eng, false));
	await sleep(tickMs);
}

process.stdout.write("\n");
console.log("flat: " + isFlat(eng));
