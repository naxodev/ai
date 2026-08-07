/**
 * Manual eyeball: calm blue bars while "playing", then decay to a still baseline.
 * Run: bun scripts/waveform-demo.ts
 */
import {
	createEngine,
	isFlat,
	renderWave,
	stepEngine,
} from "../extensions/music-dock/waveform.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const eng = createEngine(16, "demo");
const originMs = performance.now();
const tickMs = 64;

// Phase A — playing pulse (~2 s)
const playUntil = originMs + 2000;
while (performance.now() < playUntil) {
	const now = performance.now();
	stepEngine(eng, now - originMs, true, now);
	process.stdout.write("\r▶ " + renderWave(eng, true));
	await sleep(tickMs);
}

// Phase B — paused decay (~1.5 s)
const pauseUntil = performance.now() + 1500;
while (performance.now() < pauseUntil) {
	const now = performance.now();
	stepEngine(eng, now - originMs, false, now);
	process.stdout.write("\r⏸ " + renderWave(eng, false));
	await sleep(tickMs);
}

process.stdout.write("\n");
console.log("flat: " + isFlat(eng));
