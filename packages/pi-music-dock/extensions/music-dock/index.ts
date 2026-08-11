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
type Waveform = ReturnType<typeof createWaveformCoordinator>;
type TransportKind = "play" | "pause" | "next" | "previous";
type TransportIntent = {
	kind: TransportKind;
	ctx: ExtensionContext;
	resolve: () => void;
};
type LiveSession = {
	id: symbol;
	active: boolean;
	ui: ExtensionContext["ui"];
	player: PlayerState | null;
	pollTimer: Timer | null;
	eventDisposer: (() => void) | null;
	waveform: Waveform;
	sampling: boolean;
	pendingSample: boolean;
	sampleRequestSequence: number;
	samplingPromise: Promise<void> | null;
	transportRevision: number;
	pendingIntents: TransportIntent[];
	activeIntent: TransportIntent | null;
};

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
	const backend = deps.backend;
	let currentSession: LiveSession | null = null;

	const isLive = (session: LiveSession) =>
		session.active && currentSession === session;
	const stopPoll = (session: LiveSession) => {
		if (!session.pollTimer) return;
		deps.clearTimeout(session.pollTimer);
		session.pollTimer = null;
	};
	const clearStatus = (session: LiveSession) =>
		session.ui.setStatus(STATUS_KEY, undefined);
	const renderStatus = (
		session: LiveSession,
		current: PlayerState,
		engine: Parameters<typeof renderWave>[0],
	) => {
		if (!isLive(session)) return;
		const track = current.track;
		if (!track) {
			clearStatus(session);
			return;
		}
		const icon = current.is_playing ? "⏸" : "▶";
		const dimText = session.ui.theme.fg(
			"dim",
			`${clipWords(track.name, 6)} · ${clipWords(track.artists, 4)}`,
		);
		session.ui.setStatus(
			STATUS_KEY,
			`${icon} ${renderWave(engine, current.is_playing)} ${dimText}`,
		);
	};
	const project = (
		session: LiveSession,
		next: PlayerState | null,
		authoritative = false,
	) => {
		if (!isLive(session)) return;
		session.player = authoritative ? next : mergePlayer(session.player, next);
		session.waveform.setPlayer(session.player);
		if (session.player?.track) session.waveform.frame();
		else {
			clearStatus(session);
			session.waveform.stop();
		}
	};
	const schedulePoll = (session: LiveSession) => {
		if (!isLive(session)) return;
		stopPoll(session);
		const ms = session.player?.is_playing
			? POLL_PLAYING_MS
			: session.player?.track
				? POLL_PAUSED_MS
				: POLL_IDLE_MS;
		session.pollTimer = deps.setTimeout(() => {
			session.pollTimer = null;
			void requestSample(session);
		}, ms);
	};
	const requestSample = (session: LiveSession): Promise<void> => {
		if (!isLive(session)) return Promise.resolve();
		session.sampleRequestSequence++;
		stopPoll(session);
		if (session.sampling) {
			session.pendingSample = true;
			return session.samplingPromise ?? Promise.resolve();
		}
		session.sampling = true;
		const drain = (async () => {
			try {
				do {
					session.pendingSample = false;
					const sequence = session.sampleRequestSequence;
					const revision = session.transportRevision;
					try {
						const sampled = await backend.player();
						if (
							isLive(session) &&
							sequence === session.sampleRequestSequence &&
							revision === session.transportRevision
						) {
							project(session, sampled);
						}
					} catch {
						// Sampling is recovery work. A later bounded poll retries failures.
					}
				} while (isLive(session) && session.pendingSample);
			} finally {
				session.sampling = false;
				if (isLive(session)) schedulePoll(session);
			}
		})();
		session.samplingPromise = drain;
		void drain.then(() => {
			if (session.samplingPromise === drain) session.samplingPromise = null;
		});
		return drain;
	};
	const scheduleReconciliation = (session: LiveSession, delay: number) => {
		void deps.sleep(delay).then(
			() => {
				if (isLive(session)) void requestSample(session);
			},
			() => {},
		);
	};
	const runTransport = (session: LiveSession) => {
		if (
			!isLive(session) ||
			session.activeIntent ||
			!session.pendingIntents.length
		)
			return;
		const intent = session.pendingIntents.shift()!;
		session.activeIntent = intent;
		void Promise.resolve()
			.then(() => {
				if (!isLive(session) || session.activeIntent !== intent) return;
				return intent.kind === "play"
					? backend.play()
					: intent.kind === "pause"
						? backend.pause!()
						: intent.kind === "next"
							? backend.next!()
							: backend.previous!();
			})
			.then(
				() => {
					if (!isLive(session) || session.activeIntent !== intent) return;
					session.transportRevision++;
					if (intent.kind === "play" || intent.kind === "pause") {
						if (session.player) {
							project(
								session,
								{
									...session.player,
									is_playing: intent.kind === "play",
									fetched_at: Date.now(),
								},
								true,
							);
							session.waveform.start();
						}
					}
					scheduleReconciliation(
						session,
						intent.kind === "next" || intent.kind === "previous" ? 150 : 120,
					);
				},
				(error) => {
					if (isLive(session) && session.activeIntent === intent)
						intent.ctx.ui.notify(errMsg(error), "error");
				},
			)
			.then(() => {
				if (session.activeIntent === intent) session.activeIntent = null;
				intent.resolve();
				if (isLive(session)) queueMicrotask(() => runTransport(session));
			});
	};
	const enqueueTransport = (
		session: LiveSession,
		ctx: ExtensionContext,
		kind: TransportKind,
	) => {
		if (!isLive(session)) return Promise.resolve();
		if (
			(kind === "pause" && !backend.pause) ||
			(kind === "next" && !backend.next) ||
			(kind === "previous" && !backend.previous)
		)
			return Promise.resolve();
		return new Promise<void>((resolve) => {
			session.pendingIntents.push({ kind, ctx, resolve });
			runTransport(session);
		});
	};
	const precedingPlaybackTarget = (session: LiveSession) => {
		const intents = session.activeIntent
			? [session.activeIntent, ...session.pendingIntents]
			: session.pendingIntents;
		for (let index = intents.length - 1; index >= 0; index--) {
			const kind = intents[index]!.kind;
			if (kind === "play") return true;
			if (kind === "pause") return false;
		}
		return !!session.player?.is_playing;
	};
	const playPause = (ctx: ExtensionContext) => {
		const session = currentSession;
		if (!session || !isLive(session)) return Promise.resolve();
		return enqueueTransport(
			session,
			ctx,
			precedingPlaybackTarget(session) ? "pause" : "play",
		);
	};
	const skipNext = (ctx: ExtensionContext) => {
		const session = currentSession;
		return session ? enqueueTransport(session, ctx, "next") : Promise.resolve();
	};
	const skipPrev = (ctx: ExtensionContext) => {
		const session = currentSession;
		return session
			? enqueueTransport(session, ctx, "previous")
			: Promise.resolve();
	};
	const dispose = (
		session: LiveSession | null,
		clearUi?: ExtensionContext["ui"],
	) => {
		if (!session || !session.active) {
			clearUi?.setStatus(STATUS_KEY, undefined);
			return;
		}
		session.active = false;
		if (currentSession === session) currentSession = null;
		for (const intent of session.pendingIntents.splice(0)) intent.resolve();
		session.activeIntent?.resolve();
		session.activeIntent = null;
		session.pendingSample = false;
		session.eventDisposer?.();
		session.eventDisposer = null;
		stopPoll(session);
		session.waveform.dispose();
		if (clearUi) clearUi.setStatus(STATUS_KEY, undefined);
		else clearStatus(session);
		session.player = null;
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
		dispose(currentSession);
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
		const session = {} as LiveSession;
		session.id = Symbol();
		session.active = true;
		session.ui = ctx.ui;
		session.player = null;
		session.pollTimer = null;
		session.eventDisposer = null;
		session.sampling = false;
		session.pendingSample = false;
		session.sampleRequestSequence = 0;
		session.samplingPromise = null;
		session.transportRevision = 0;
		session.pendingIntents = [];
		session.activeIntent = null;
		session.waveform = createWaveformCoordinator({
			now: Date.now,
			scheduler: {
				setInterval: (callback, ms) => deps.setInterval(callback, ms),
				clearInterval: (timer) => deps.clearInterval(timer as Interval),
			},
			render: (current, engine) => renderStatus(session, current, engine),
		});
		currentSession = session;
		session.eventDisposer =
			backend.subscribe?.((event) => {
				if (!isLive(session)) return;
				if (event?.type === "snapshot") {
					session.sampleRequestSequence++;
					session.pendingSample = false;
					project(session, event.state, true);
					if (!session.sampling) schedulePoll(session);
					return;
				}
				void requestSample(session);
			}) ?? null;
		await requestSample(session);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		dispose(currentSession, ctx.ui);
	});
}

export default function (pi: ExtensionAPI) {
	createMusicDock(pi);
}
