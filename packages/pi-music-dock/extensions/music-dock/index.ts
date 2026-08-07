/**
 * Pi extension: system-media now-playing status line + transport shortcuts.
 * Composes via setStatus only — does not own the footer (jj-footer does).
 */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { clipWords } from "./format.ts";
import {
	createSystemMedia,
	hasMediaControl,
	hasNowPlayingCli,
	trackKey,
} from "./media.ts";
import { isMac, type MusicBackend, type PlayerState } from "./types.ts";
import {
	createEngine,
	isFlat,
	renderWave,
	stepEngine,
	type WaveEngine,
} from "./waveform.ts";

// ctrl+alt+* — same pattern as pi plan-mode; avoids model-cycle and editor word-nav.
const KEY_PLAY_PAUSE = Key.ctrlAlt("p");
const KEY_NEXT = Key.ctrlAlt("n");
const KEY_PREV = Key.ctrlAlt("b");
const POLL_PLAYING_MS = 3000;
const POLL_PAUSED_MS = 5000;
const POLL_IDLE_MS = 8000;
const ANIM_MS = 100;
const WAVE_BARS = 16;
const STATUS_KEY = "music-dock";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function errMsg(e: unknown): string {
	if (e && typeof e === "object" && "message" in e) {
		return String((e as { message: unknown }).message);
	}
	return String(e);
}

export default function (pi: ExtensionAPI) {
	let player: PlayerState | null = null;
	let engine: WaveEngine | null = null;
	let engineKey = "";
	let originMs = 0;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let animTimer: ReturnType<typeof setInterval> | null = null;
	let ui: ExtensionContext["ui"] | null = null;
	let disposed = false;
	let busy = false;
	let polling = false;
	const backend: MusicBackend = createSystemMedia();

	/** Keep progress monotonic; never let a poll un-pause a held pause. */
	const mergePlayer = (
		prev: PlayerState | null,
		next: PlayerState | null,
	): PlayerState | null => {
		if (!next) return next;
		if (!prev?.track || !next.track) return next;
		if (
			prev.track.id !== next.track.id &&
			prev.track.name !== next.track.name
		) {
			return next;
		}

		const now = Date.now();
		const prevLive = prev.is_playing
			? prev.progress_ms + (now - prev.fetched_at)
			: prev.progress_ms;

		// Same track: ignore a sudden drop to ~0 while still playing.
		if (
			next.is_playing &&
			prevLive > 2000 &&
			next.progress_ms < 500 &&
			next.track.duration_ms > 0 &&
			next.progress_ms + 3000 < prevLive
		) {
			return {
				...next,
				progress_ms: Math.min(next.track.duration_ms, Math.round(prevLive)),
				fetched_at: now,
			};
		}
		return next;
	};

	const stopAnim = () => {
		if (!animTimer) return;
		clearInterval(animTimer);
		animTimer = null;
	};

	const stopPoll = () => {
		if (!pollTimer) return;
		clearTimeout(pollTimer);
		pollTimer = null;
	};

	const clearStatus = () => {
		ui?.setStatus(STATUS_KEY, undefined);
	};

	const disposeVia = (target: ExtensionContext["ui"] | null) => {
		disposed = true;
		stopPoll();
		stopAnim();
		target?.setStatus(STATUS_KEY, undefined);
		player = null;
		engine = null;
		engineKey = "";
		originMs = 0;
		ui = null;
		busy = false;
		polling = false;
	};

	const dispose = () => disposeVia(ui);

	const ensureEngine = (track: NonNullable<PlayerState["track"]>) => {
		const key = trackKey(track.name, track.artists, track.id);
		if (key !== engineKey || !engine) {
			engine = createEngine(WAVE_BARS, key);
			engineKey = key;
			originMs = performance.now();
		}
	};

	const renderStatus = () => {
		if (!ui || disposed) return;
		const track = player?.track;
		if (!player || !track || !engine) {
			clearStatus();
			stopAnim();
			return;
		}

		ensureEngine(track);

		// Action affordance: show what the control will do (pause while playing).
		const icon = player.is_playing ? "⏸" : "▶";
		const dimText = ui.theme.fg(
			"dim",
			`${clipWords(track.name, 6)} · ${clipWords(track.artists, 4)}`,
		);
		const line = `${icon} ${renderWave(engine, player.is_playing)} ${dimText}`;
		ui.setStatus(STATUS_KEY, line);
	};

	const tick = () => {
		if (!ui || disposed) {
			stopAnim();
			return;
		}
		if (!engine || !player?.track) {
			clearStatus();
			stopAnim();
			return;
		}

		const playing = player.is_playing;
		stepEngine(
			engine,
			performance.now() - originMs + player.progress_ms * 0.2,
			playing,
			performance.now(),
		);
		renderStatus();

		// Stop re-rendering once paused levels are flat — footer stays still.
		if (!playing && isFlat(engine)) {
			stopAnim();
		}
	};

	const startAnim = () => {
		if (animTimer || disposed) return;
		animTimer = setInterval(tick, ANIM_MS);
	};

	const refreshPlayer = async () => {
		if (polling) return;
		polling = true;
		try {
			const next = mergePlayer(player, await backend.player());
			if (disposed) return;
			player = next;

			const track = player?.track;
			if (track) {
				ensureEngine(track);
				renderStatus();
				if (player?.is_playing) startAnim();
				else if (engine && isFlat(engine)) stopAnim();
				else if (player && !player.is_playing) startAnim(); // decay to flat
			} else {
				engine = null;
				engineKey = "";
				clearStatus();
				stopAnim();
			}
		} catch {
			// Poll failures are transient; next cycle retries.
		} finally {
			polling = false;
		}
	};

	const schedulePoll = () => {
		if (disposed) return;
		if (pollTimer) clearTimeout(pollTimer);
		const playing = !!player?.is_playing;
		const idle = !player?.track;
		const ms = playing ? POLL_PLAYING_MS : idle ? POLL_IDLE_MS : POLL_PAUSED_MS;
		pollTimer = setTimeout(() => {
			void refreshPlayer().finally(() => schedulePoll());
		}, ms);
	};

	const withBusy = async (ctx: ExtensionContext, fn: () => Promise<void>) => {
		if (busy) return;
		busy = true;
		try {
			await fn();
		} catch (e) {
			ctx.ui.notify(errMsg(e), "error");
		} finally {
			busy = false;
		}
	};

	const playPause = async (ctx: ExtensionContext) => {
		if (ui === null) return;
		await withBusy(ctx, async () => {
			const wasPlaying = !!player?.is_playing;
			if (wasPlaying) await backend.pause?.();
			else await backend.play();

			// Instant icon/wave feedback; backend setPlaying keeps the clock honest.
			if (player) {
				player = {
					...player,
					is_playing: !wasPlaying,
					fetched_at: Date.now(),
				};
				startAnim(); // resumes motion on play; on pause, runs the decay-to-flat path
				renderStatus();
			}

			await sleep(120);
			await refreshPlayer();
			schedulePoll();
		});
	};

	const skipNext = async (ctx: ExtensionContext) => {
		if (ui === null) return;
		await withBusy(ctx, async () => {
			await backend.next?.();
			await sleep(150);
			await refreshPlayer();
			schedulePoll();
		});
	};

	const skipPrev = async (ctx: ExtensionContext) => {
		if (ui === null) return;
		await withBusy(ctx, async () => {
			await backend.previous?.();
			await sleep(150);
			await refreshPlayer();
			schedulePoll();
		});
	};

	pi.registerShortcut(KEY_PLAY_PAUSE, {
		description: "Music: play/pause",
		handler: playPause,
	});
	pi.registerShortcut(KEY_NEXT, {
		description: "Music: next track",
		handler: skipNext,
	});
	pi.registerShortcut(KEY_PREV, {
		description: "Music: previous track",
		handler: skipPrev,
	});

	// Slash commands always work (no terminal chord issues).
	// Handler signature is (args, ctx) — not (ctx).
	pi.registerCommand("music", {
		description: "Music: play/pause",
		handler: async (_args, ctx) => {
			await playPause(ctx);
		},
	});
	pi.registerCommand("music-next", {
		description: "Music: next track",
		handler: async (_args, ctx) => {
			await skipNext(ctx);
		},
	});
	pi.registerCommand("music-prev", {
		description: "Music: previous track",
		handler: async (_args, ctx) => {
			await skipPrev(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		// /reload refires session_start — tear down first so timers don't stack.
		dispose();

		if (!isMac()) {
			ctx.ui.notify(
				"music-dock: system media control is macOS-only",
				"warning",
			);
			return;
		}
		if (!hasMediaControl() && !hasNowPlayingCli()) {
			ctx.ui.notify(
				"music-dock: brew tap ungive/media-control && brew install media-control",
				"warning",
			);
			return;
		}

		ui = ctx.ui;
		disposed = false;
		void refreshPlayer().finally(() => schedulePoll());
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		// Clear via ctx.ui in case dispose already nulled the capture.
		disposeVia(ctx.ui);
	});
}
