/** Pi extension: daemon-backed now-playing status plus transport shortcuts. */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
	createReconnectingMusicSessionClient,
	type MusicSessionConnectionLifecycle,
	type PlayerState,
	type ProviderStatus,
	type ReconnectingMusicSessionClient,
	type ReconnectingMusicSessionClientOptions,
	type RevisionedState,
} from "@naxodev/music-core";
import { clipWords } from "./format.ts";
import { createWaveformCoordinator, renderWave } from "./waveform.ts";

const KEY_PLAY_PAUSE = Key.ctrlAlt("p");
const KEY_NEXT = Key.ctrlAlt("n");
const KEY_PREV = Key.ctrlAlt("b");
const STATUS_KEY = "music-dock";

type Interval = ReturnType<typeof setInterval>;
type Waveform = ReturnType<typeof createWaveformCoordinator>;
type ClientFactory = (
	options: ReconnectingMusicSessionClientOptions,
) => Promise<ReconnectingMusicSessionClient>;
type LiveSession = {
	readonly id: symbol;
	active: boolean;
	readonly ui: ExtensionContext["ui"];
	player: PlayerState | null;
	client: ReconnectingMusicSessionClient | undefined;
	acquisition: Promise<void>;
	clientDisposed: boolean;
	unsubscribers: Array<() => void>;
	waveform: Waveform;
	providerNotification: string | undefined;
	reconnectingNotification: string | undefined;
	terminalNotification: string | undefined;
	acquisitionNotification: string | undefined;
};

export type MusicDockDependencies = {
	createClient: ClientFactory;
	now: () => number;
	setInterval: (callback: () => void, delayMs: number) => Interval;
	clearInterval: (timer: Interval) => void;
};

let clientSequence = 0;

function errMsg(error: unknown): string {
	return error && typeof error === "object" && "message" in error
		? String((error as { message: unknown }).message)
		: String(error);
}

export function createMusicDock(
	pi: ExtensionAPI,
	overrides: Partial<MusicDockDependencies> = {},
) {
	const deps: MusicDockDependencies = {
		createClient: createReconnectingMusicSessionClient,
		now: Date.now,
		setInterval,
		clearInterval,
		...overrides,
	};
	let currentSession: LiveSession | null = null;

	const isLive = (session: LiveSession) =>
		session.active && currentSession === session;
	const clearStatus = (session: LiveSession) =>
		session.ui.setStatus(STATUS_KEY, undefined);
	const notify = (
		session: LiveSession,
		kind: "provider" | "reconnecting" | "terminal" | "acquisition",
		message: string,
	) => {
		if (!isLive(session)) return;
		const key = `${kind}Notification` as const;
		if (session[key] === message) return;
		session[key] = message;
		session.ui.notify(message, "error");
	};
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
	const project = (session: LiveSession, state: RevisionedState) => {
		if (!isLive(session)) return;
		session.player = state.state;
		session.waveform.setPlayer(session.player);
		if (session.player.track) session.waveform.frame();
		else {
			clearStatus(session);
			session.waveform.stop();
		}
	};
	const reportStatus = (session: LiveSession, status: ProviderStatus) => {
		if (status.kind === "ready") session.providerNotification = undefined;
		else notify(session, "provider", status.message);
	};
	const reportConnection = (
		session: LiveSession,
		connection: MusicSessionConnectionLifecycle,
	) => {
		if (connection.type === "connected") {
			session.reconnectingNotification = undefined;
			session.terminalNotification = undefined;
		} else if (connection.type === "reconnecting")
			notify(session, "reconnecting", connection.error.message);
		else if (connection.type === "terminal")
			notify(session, "terminal", connection.error.message);
	};
	const disposeClient = async (
		session: LiveSession,
		client = session.client,
	) => {
		if (!client || session.clientDisposed) return;
		session.clientDisposed = true;
		await client.dispose().catch(() => {});
	};
	const install = (
		session: LiveSession,
		client: ReconnectingMusicSessionClient,
	) => {
		if (!isLive(session)) return disposeClient(session, client);
		session.client = client;
		session.unsubscribers = [
			client.subscribeState((state) => project(session, state)),
			client.subscribeStatus((status) => reportStatus(session, status)),
			client.subscribeConnection((connection) =>
				reportConnection(session, connection),
			),
		];
	};
	const shutdown = async (
		session: LiveSession | null,
		clearUi?: ExtensionContext["ui"],
	) => {
		if (!session || !session.active) {
			clearUi?.setStatus(STATUS_KEY, undefined);
			return;
		}
		session.active = false;
		if (currentSession === session) currentSession = null;
		for (const unsubscribe of session.unsubscribers.splice(0)) unsubscribe();
		session.waveform.dispose();
		if (clearUi) clearUi.setStatus(STATUS_KEY, undefined);
		else clearStatus(session);
		session.player = null;
		await session.acquisition;
		await disposeClient(session);
	};
	const command = (
		ctx: ExtensionContext,
		run: (client: ReconnectingMusicSessionClient) => Promise<unknown>,
	) => {
		const session = currentSession;
		if (!session || !isLive(session)) return Promise.resolve();
		const invoke = (client: ReconnectingMusicSessionClient) =>
			run(client).then(
				() => undefined,
				(error) => {
					if (isLive(session)) ctx.ui.notify(errMsg(error), "error");
				},
			);
		if (session.client) return invoke(session.client);
		// This is an acquisition gate, not a transport queue: every caller
		// waits only for its live generation's one client, then delegates once.
		return session.acquisition.then(() =>
			isLive(session) && session.client ? invoke(session.client) : undefined,
		);
	};
	const playPause = (ctx: ExtensionContext) =>
		command(ctx, (client) => client.toggle());
	const skipNext = (ctx: ExtensionContext) =>
		command(ctx, (client) => client.next());
	const skipPrev = (ctx: ExtensionContext) =>
		command(ctx, (client) => client.previous());

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
		handler: async (_args, ctx) => playPause(ctx),
	});
	pi.registerCommand("music-next", {
		description: "Music: next track",
		handler: async (_args, ctx) => skipNext(ctx),
	});
	pi.registerCommand("music-prev", {
		description: "Music: previous track",
		handler: async (_args, ctx) => skipPrev(ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		await shutdown(currentSession);
		const session: LiveSession = {
			id: Symbol(),
			active: true,
			ui: ctx.ui,
			player: null,
			client: undefined,
			acquisition: Promise.resolve(),
			clientDisposed: false,
			unsubscribers: [],
			waveform: undefined as never,
			providerNotification: undefined,
			reconnectingNotification: undefined,
			terminalNotification: undefined,
			acquisitionNotification: undefined,
		};
		session.waveform = createWaveformCoordinator({
			now: deps.now,
			scheduler: {
				setInterval: (callback, ms) => deps.setInterval(callback, ms),
				clearInterval: (timer) => deps.clearInterval(timer as Interval),
			},
			render: (player, engine) => renderStatus(session, player, engine),
		});
		currentSession = session;
		const options: ReconnectingMusicSessionClientOptions = {
			clientId: `pi-music-dock-${++clientSequence}`,
			hostKind: "pi",
			capabilities: ["state-replay", "transport"],
		};
		session.acquisition = Promise.resolve()
			.then(() => deps.createClient(options))
			.then(
				async (client) => {
					await install(session, client);
				},
				(error) => {
					notify(session, "acquisition", errMsg(error));
				},
			);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		await shutdown(currentSession, ctx.ui);
	});
}

export default function (pi: ExtensionAPI) {
	createMusicDock(pi);
}
