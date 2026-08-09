/**
 * Pi extension: system-media now-playing status line + transport shortcuts.
 * Composes via setStatus only — does not own the footer (jj-footer does).
 */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
	createSystemMedia,
	hasMediaControl,
	hasNowPlayingCli,
	isMac,
	mergePlayer,
	type MusicBackend,
	type PlayerState,
} from "@naxodev/music-core";
import { clipWords } from "./format.ts";
import { createWaveformCoordinator, renderWave } from "./waveform.ts";

// ctrl+alt+* — same pattern as pi plan-mode; avoids model-cycle and editor word-nav.
const KEY_PLAY_PAUSE = Key.ctrlAlt("p");
const KEY_NEXT = Key.ctrlAlt("n");
const KEY_PREV = Key.ctrlAlt("b");
const POLL_PLAYING_MS = 3000;
const POLL_PAUSED_MS = 5000;
const POLL_IDLE_MS = 8000;
const STATUS_KEY = "music-dock";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Timer = ReturnType<typeof setTimeout>;
type Interval = ReturnType<typeof setInterval>;

export type MusicDockDependencies = {
	backend: MusicBackend;
	isMac: () => boolean;
	hasMediaControl: () => boolean;
	hasNowPlayingCli: () => boolean;
	setTimeout: (callback: () => void, delayMs: number) => Timer;
	clearTimeout: (timer: Timer) => void;
	setInterval: (callback: () => void, delayMs: number) => Interval;
	clearInterval: (timer: Interval) => void;
	sleep: (ms: number) => Promise<void>;
};

function errMsg(e: unknown): string {
	if (e && typeof e === "object" && "message" in e) {
		return String((e as { message: unknown }).message);
	}
	return String(e);
}

export function createMusicDock(
	pi: ExtensionAPI,
	overrides: Partial<MusicDockDependencies> = {},
) {
	const deps: MusicDockDependencies = {
		backend: overrides.backend ?? createSystemMedia(),
		isMac,
		hasMediaControl,
		hasNowPlayingCli,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		sleep,
		...overrides,
	};
	let player: PlayerState | null = null;
	let pollTimer: Timer | null = null;
	let eventDisposer: (() => void) | null = null;
	let ui: ExtensionContext["ui"] | null = null;
	let disposed = false;
	type RefreshSession = {
		sampling: boolean;
		pending: boolean;
		busy: symbol | null;
		transportRevision: number;
	};
	let refreshSession: RefreshSession = {
		sampling: false,
		pending: false,
		busy: null,
		transportRevision: 0,
	};
	const backend = deps.backend;
	const isCurrent = (session: RefreshSession) =>
		session === refreshSession && !disposed;
	const waveform = createWaveformCoordinator({
		now: Date.now,
		scheduler: {
			setInterval: (callback, ms) => deps.setInterval(callback, ms),
			clearInterval: (timer) => deps.clearInterval(timer as Interval),
		},
		render: (current, engine) => renderStatus(current, engine),
	});

	const stopPoll = () => {
		if (!pollTimer) return;
		deps.clearTimeout(pollTimer);
		pollTimer = null;
	};

	const clearStatus = () => {
		ui?.setStatus(STATUS_KEY, undefined);
	};

	const disposeVia = (target: ExtensionContext["ui"] | null) => {
		target?.setStatus(STATUS_KEY, undefined);
		if (disposed) return;
		disposed = true;
		eventDisposer?.();
		eventDisposer = null;
		stopPoll();
		waveform.dispose();
		player = null;
		ui = null;
		refreshSession.pending = false;
	};

	const dispose = () => disposeVia(ui);

	const renderStatus = (
		current: PlayerState,
		engine: Parameters<typeof renderWave>[0],
	) => {
		if (!ui || disposed) return;
		const track = current.track;
		if (!track) {
			clearStatus();
			return;
		}

		// Action affordance: show what the control will do (pause while playing).
		const icon = current.is_playing ? "⏸" : "▶";
		const dimText = ui.theme.fg(
			"dim",
			`${clipWords(track.name, 6)} · ${clipWords(track.artists, 4)}`,
		);
		const line = `${icon} ${renderWave(engine, current.is_playing)} ${dimText}`;
		ui.setStatus(STATUS_KEY, line);
	};

	const samplePlayer = async (session: RefreshSession) => {
		try {
			const revision = session.transportRevision;
			const sampled = await backend.player();
			if (!isCurrent(session)) return;
			if (revision !== session.transportRevision) return;
			const next = mergePlayer(player, sampled);
			player = next;
			waveform.setPlayer(player);

			if (player?.track) {
				// Step before rendering so a replacement anchors its first visible frame.
				waveform.frame();
			} else {
				clearStatus();
				waveform.stop();
			}
		} catch {
			// Poll failures are transient; next cycle retries.
		}
	};

	const requestRefresh = async (session = refreshSession) => {
		if (!isCurrent(session)) return;
		session.pending = true;
		if (session.sampling) return;
		session.sampling = true;
		try {
			do {
				session.pending = false;
				await samplePlayer(session);
			} while (isCurrent(session) && session.pending);
		} finally {
			session.sampling = false;
			if (isCurrent(session)) schedulePoll(session);
		}
	};

	const schedulePoll = (session = refreshSession) => {
		if (!isCurrent(session)) return;
		if (pollTimer) deps.clearTimeout(pollTimer);
		const playing = !!player?.is_playing;
		const idle = !player?.track;
		const ms = playing ? POLL_PLAYING_MS : idle ? POLL_IDLE_MS : POLL_PAUSED_MS;
		pollTimer = deps.setTimeout(() => {
			pollTimer = null;
			void requestRefresh(session);
		}, ms);
	};

	const withBusy = async (
		session: RefreshSession,
		ctx: ExtensionContext,
		fn: () => Promise<void>,
	) => {
		if (!isCurrent(session) || session.busy) return;
		const operation = Symbol();
		session.busy = operation;
		try {
			await fn();
		} catch (e) {
			if (isCurrent(session)) ctx.ui.notify(errMsg(e), "error");
		} finally {
			if (isCurrent(session) && session.busy === operation) {
				session.busy = null;
			}
		}
	};

	const playPause = async (ctx: ExtensionContext) => {
		if (ui === null) return;
		const session = refreshSession;
		await withBusy(session, ctx, async () => {
			const wasPlaying = !!player?.is_playing;
			if (wasPlaying) await backend.pause?.();
			else await backend.play();
			if (!isCurrent(session)) return;
			session.transportRevision++;

			// Instant icon/wave feedback; backend setPlaying keeps the clock honest.
			if (player) {
				player = {
					...player,
					is_playing: !wasPlaying,
					fetched_at: Date.now(),
				};
				waveform.setPlayer(player);
				waveform.start(); // Starts before the refresh delay on resume.
				waveform.frame();
			}

			await deps.sleep(120);
			await requestRefresh(session);
		});
	};

	const skipNext = async (ctx: ExtensionContext) => {
		if (ui === null) return;
		const session = refreshSession;
		await withBusy(session, ctx, async () => {
			await backend.next?.();
			if (!isCurrent(session)) return;
			session.transportRevision++;
			await deps.sleep(150);
			await requestRefresh(session);
		});
	};

	const skipPrev = async (ctx: ExtensionContext) => {
		if (ui === null) return;
		const session = refreshSession;
		await withBusy(session, ctx, async () => {
			await backend.previous?.();
			if (!isCurrent(session)) return;
			session.transportRevision++;
			await deps.sleep(150);
			await requestRefresh(session);
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

		if (!deps.isMac()) {
			ctx.ui.notify(
				"music-dock: system media control is macOS-only",
				"warning",
			);
			return;
		}
		if (!deps.hasMediaControl() && !deps.hasNowPlayingCli()) {
			ctx.ui.notify(
				"music-dock: brew tap ungive/media-control && brew install media-control",
				"warning",
			);
			return;
		}

		ui = ctx.ui;
		disposed = false;
		const session: RefreshSession = {
			sampling: false,
			pending: false,
			busy: null,
			transportRevision: 0,
		};
		refreshSession = session;
		eventDisposer =
			backend.subscribe?.(() => void requestRefresh(session)) ?? null;
		await requestRefresh(session);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		// Clear via ctx.ui in case dispose already nulled the capture.
		disposeVia(ctx.ui);
	});
}

export default function (pi: ExtensionAPI) {
	createMusicDock(pi);
}
