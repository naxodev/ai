/** Pi extension: daemon-backed now-playing status, side panel, and transport. */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	createReconnectingMusicSessionClient,
	type ArtworkIdentity,
	type MusicSessionConnectionLifecycle,
	type PlayerState,
	type ProviderStatus,
	type ReconnectingMusicSessionClient,
	type ReconnectingMusicSessionClientOptions,
	type RevisionedState,
	type WaveEngine,
} from "@naxodev/music-core";
import {
	artworkFenceKey,
	defaultArtworkFetch,
	resolveArtworkPresentation,
	trackArtworkIdentity,
	type ArtworkFetcher,
	type ArtworkPresentation,
} from "./artwork.ts";
import { clipWords, sanitizeTerminalText } from "./format.ts";
import {
	createMusicChip,
	createMusicSidebar,
	type MusicChip,
	type MusicSidebar,
	type MusicSidebarState,
} from "./sidebar.ts";
import { createWaveformCoordinator, renderWave } from "./waveform.ts";

const KEY_PLAY_PAUSE = Key.ctrlAlt("p");
const KEY_NEXT = Key.ctrlAlt("n");
const KEY_PREV = Key.ctrlAlt("b");
const KEY_VIEW = Key.ctrlAlt("m");
const STATUS_KEY = "music-dock";
/** Empty host widget key — factory only exists to receive TUI/theme and own the overlay. */
const OVERLAY_HOST_WIDGET_KEY = "music-dock-sidebar-host";
const SIDEBAR_MIN_COLS = 80;
const SIDEBAR_WIDTH = 30;
const SIDEBAR_MAX_HEIGHT = "90%";
/** Compact streaming chip anchor: bottom-right, clear of the input line. */
const CHIP_ANCHOR = "bottom-right" as const;
const CHIP_MARGIN = { right: 1, bottom: 1 } as const;

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
	readonly acquisitionAbort: AbortController;
	clientDisposed: boolean;
	unsubscribers: Array<() => void>;
	waveform: Waveform;
	providerNotification: string | undefined;
	reconnectingNotification: string | undefined;
	terminalNotification: string | undefined;
	acquisitionNotification: string | undefined;
	// Side panel host owns overlay handles + sidebar/chip; cleared with the key.
	sidebar: MusicSidebar | undefined;
	overlayHandle: OverlayHandle | undefined;
	chip: MusicChip | undefined;
	chipOverlayHandle: OverlayHandle | undefined;
	/** True between agent_start and agent_end/agent_settled events. */
	streaming: boolean;
	hostMounted: boolean;
	userHidden: boolean;
	focused: boolean;
	artwork: ArtworkPresentation;
	artworkFence: string | undefined;
	artworkGeneration: number;
	artworkAbort: AbortController | undefined;
};

export type MusicDockDependencies = {
	createClient: ClientFactory;
	now: () => number;
	setInterval: (callback: () => void, delayMs: number) => Interval;
	clearInterval: (timer: Interval) => void;
	/** Injected fetch seam for catalog fallback — tests never hit the network. */
	fetch: ArtworkFetcher;
	/**
	 * Collapse threshold seam: when true (default), a streaming agent session
	 * collapses the full panel into the bottom-right chip. Inject false to
	 * disable collapse in tests or user settings.
	 */
	collapseOnStreaming?: boolean;
};

export type { MusicSidebar, MusicSidebarState } from "./sidebar.ts";
export { artworkImageKey } from "./sidebar.ts";
export {
	detectImageMimeFromBase64,
	presentArtworkResult,
	resolveArtworkPresentation,
	selectArtworkUrl,
	trackArtworkIdentity,
	artworkFenceKey,
} from "./artwork.ts";

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
		fetch: defaultArtworkFetch,
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
		const safeMessage = sanitizeTerminalText(message);
		if (session[key] === safeMessage) return;
		session[key] = safeMessage;
		session.ui.notify(safeMessage, "error");
	};

	const pushSidebar = (
		session: LiveSession,
		patch: Partial<MusicSidebarState> = {},
	) => {
		if (!session.sidebar || !isLive(session)) return;
		const artwork = patch.artwork ?? session.artwork;
		const player = patch.player !== undefined ? patch.player : session.player;
		session.sidebar.update({
			artwork,
			focused: session.focused,
			hiddenByUser: session.userHidden,
			...patch,
			player,
		});
		session.chip?.update({ player });
	};

	/**
	 * Collapse rule, applied as the single source of overlay visibility:
	 * streaming collapses the panel into the chip unless the panel is focused
	 * or the user hid everything; userHidden hides both.
	 */
	const collapsedFor = (session: LiveSession): boolean =>
		Boolean(deps.collapseOnStreaming ?? true) &&
		session.streaming &&
		!session.focused;

	const applyVisibility = (session: LiveSession) => {
		if (!isLive(session)) return;
		const collapsed = collapsedFor(session);
		try {
			session.overlayHandle?.setHidden(session.userHidden || collapsed);
		} catch {
			// ignore
		}
		try {
			session.chipOverlayHandle?.setHidden(session.userHidden || !collapsed);
		} catch {
			// ignore
		}
	};

	const renderStatus = (
		session: LiveSession,
		current: PlayerState,
		engine: WaveEngine,
	) => {
		if (!isLive(session)) return;
		const track = current.track;
		if (!track) {
			clearStatus(session);
			pushSidebar(session, { player: current, engine: null });
			return;
		}
		const icon = current.is_playing ? "⏸" : "▶";
		const dimText = session.ui.theme.fg(
			"dim",
			`${clipWords(sanitizeTerminalText(track.name), 6)} · ${clipWords(sanitizeTerminalText(track.artists), 4)}`,
		);
		session.ui.setStatus(
			STATUS_KEY,
			`${icon} ${renderWave(engine, current.is_playing)} ${dimText}`,
		);
		pushSidebar(session, { player: current, engine });
	};

	const abortArtwork = (session: LiveSession) => {
		try {
			session.artworkAbort?.abort();
		} catch {
			// ignore repeated abort
		}
		session.artworkAbort = undefined;
	};

	const clearArtwork = (session: LiveSession) => {
		abortArtwork(session);
		session.artworkGeneration += 1;
		session.artworkFence = undefined;
		session.artwork = { kind: "empty" };
		pushSidebar(session, { artwork: session.artwork });
	};

	const requestArtwork = (
		session: LiveSession,
		client: ReconnectingMusicSessionClient,
		identity: ArtworkIdentity,
	) => {
		const fence = artworkFenceKey(identity);
		abortArtwork(session);
		const generation = ++session.artworkGeneration;
		const controller = new AbortController();
		session.artworkAbort = controller;
		session.artworkFence = fence;
		session.artwork = { kind: "loading" };
		pushSidebar(session, { artwork: session.artwork });
		// Fire-and-forget; fence by session + track so late results cannot stick.
		// Native success wins; provider failure / too-large / unsupported fall back
		// to a bounded exact iTunes catalog match (same safety rules as OpenCode).
		void resolveArtworkPresentation({
			identity,
			loadNative: () => client.artwork(identity),
			fetch: deps.fetch,
			signal: controller.signal,
		}).then(
			(presentation) => {
				if (!isLive(session)) return;
				if (session.artworkGeneration !== generation) return;
				if (session.artworkFence !== fence) return;
				if (controller.signal.aborted) return;
				session.artwork = presentation;
				pushSidebar(session, { artwork: session.artwork });
			},
			() => {
				if (!isLive(session)) return;
				if (session.artworkGeneration !== generation) return;
				if (session.artworkFence !== fence) return;
				if (controller.signal.aborted) return;
				session.artwork = { kind: "unavailable" };
				pushSidebar(session, { artwork: session.artwork });
			},
		);
	};

	const syncArtwork = (session: LiveSession, player: PlayerState) => {
		const track = player.track;
		if (!track) {
			clearArtwork(session);
			return;
		}
		const identity = trackArtworkIdentity(track);
		const fence = artworkFenceKey(identity);
		if (session.artworkFence === fence) return;
		const client = session.client;
		if (!client) {
			// Leave fence unset so install can issue the real request once.
			session.artwork = { kind: "loading" };
			pushSidebar(session, { artwork: session.artwork });
			return;
		}
		requestArtwork(session, client, identity);
	};

	const project = (session: LiveSession, state: RevisionedState) => {
		if (!isLive(session)) return;
		const previous = session.player;
		session.player = state.state;
		session.waveform.setPlayer(session.player);
		const hadTrack = Boolean(previous?.track);
		const hasTrack = Boolean(session.player.track);
		const trackChanged =
			hadTrack !== hasTrack ||
			(previous?.track &&
				session.player.track &&
				artworkFenceKey(trackArtworkIdentity(previous.track)) !==
					artworkFenceKey(trackArtworkIdentity(session.player.track)));
		if (trackChanged) syncArtwork(session, session.player);
		if (session.player.track) session.waveform.frame();
		else {
			clearStatus(session);
			session.waveform.stop();
			pushSidebar(session, { player: session.player, engine: null });
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
		// subscribeState already projects + requests when the client is assigned
		// first. If a track is present without an in-flight fence, catch up once.
		if (session.player?.track && !session.artworkFence) {
			syncArtwork(session, session.player);
		}
	};

	const chipOptionsFor = (_session: LiveSession): OverlayOptions => ({
		anchor: CHIP_ANCHOR,
		width: SIDEBAR_WIDTH,
		margin: CHIP_MARGIN,
		nonCapturing: true,
	});

	const overlayOptionsFor = (session: LiveSession): OverlayOptions => ({
		anchor: "right-center",
		width: SIDEBAR_WIDTH,
		maxHeight: SIDEBAR_MAX_HEIGHT,
		margin: { right: 1 },
		nonCapturing: true,
		visible: (termWidth) =>
			termWidth >= SIDEBAR_MIN_COLS && !session.userHidden,
	});

	/**
	 * Empty host widget: obtains TUI/theme synchronously, owns one showOverlay
	 * handle + sidebar, and tears both down idempotently from dispose().
	 * Clearing the widget key on reload/shutdown runs dispose synchronously —
	 * no custom() Promise, no done() callback.
	 */
	const createOverlayHost = (
		session: LiveSession,
		ctx: ExtensionContext,
		tui: TUI,
		theme: {
			fg: (color: never, text: string) => string;
			bg?: (color: never, text: string) => string;
		},
	): Component & { dispose: () => void } => {
		let disposed = false;
		let handle: OverlayHandle | undefined;
		let chipHandle: OverlayHandle | undefined;

		const sidebarTheme = {
			fg: (color: string, text: string) =>
				theme.fg(color as Parameters<typeof theme.fg>[0], text),
			bg: theme.bg
				? (color: string, text: string) =>
						theme.bg!(color as Parameters<typeof theme.bg>[0], text)
				: undefined,
		};

		const sidebar = createMusicSidebar(
			{
				requestRender: () => tui.requestRender(),
				terminal: tui.terminal,
			},
			sidebarTheme,
			{
				onTogglePlayback: () => {
					void playPause(ctx);
				},
				onNext: () => {
					void skipNext(ctx);
				},
				onPrevious: () => {
					void skipPrev(ctx);
				},
				onUnfocus: () => unfocusSidebar(session),
				onChange: () => tui.requestRender(),
			},
			{ now: deps.now },
		);

		if (!isLive(session)) {
			sidebar.dispose();
			return {
				render: () => [],
				invalidate: () => {},
				dispose: () => {},
			};
		}

		session.sidebar = sidebar;
		handle = tui.showOverlay(sidebar, overlayOptionsFor(session));
		session.overlayHandle = handle;

		// Second overlay handle: the compact chip shown while streaming.
		const chip = createMusicChip(sidebarTheme, { now: deps.now });
		session.chip = chip;
		chipHandle = tui.showOverlay(chip, chipOptionsFor(session));
		session.chipOverlayHandle = chipHandle;

		applyVisibility(session);
		pushSidebar(session);

		const dispose = () => {
			if (disposed) return;
			disposed = true;
			const ownedHandles = [handle, chipHandle];
			handle = undefined;
			chipHandle = undefined;
			for (const owned of ownedHandles) {
				if (!owned) continue;
				try {
					owned.hide();
				} catch {
					// ignore double-hide races
				}
				if (session.overlayHandle === owned) {
					session.overlayHandle = undefined;
				}
				if (session.chipOverlayHandle === owned) {
					session.chipOverlayHandle = undefined;
				}
			}
			chip.dispose();
			if (session.chip === chip) session.chip = undefined;
			sidebar.dispose();
			if (session.sidebar === sidebar) session.sidebar = undefined;
		};

		return {
			// Host contributes no editor chrome; the panel lives in the overlay.
			render: () => [],
			invalidate: () => {},
			dispose,
		};
	};

	const mountOverlayHost = (session: LiveSession, ctx: ExtensionContext) => {
		if (session.hostMounted || !isLive(session)) return;
		session.hostMounted = true;
		ctx.ui.setWidget(OVERLAY_HOST_WIDGET_KEY, (tui, theme) =>
			createOverlayHost(session, ctx, tui, theme),
		);
	};

	const unmountOverlayHost = (ui: ExtensionContext["ui"]) => {
		// Clearing by key synchronously disposes the host (hide + sidebar.dispose).
		ui.setWidget(OVERLAY_HOST_WIDGET_KEY, undefined);
	};

	const unfocusSidebar = (session: LiveSession) => {
		if (!isLive(session)) return;
		session.focused = false;
		pushSidebar(session, { focused: false });
		try {
			session.overlayHandle?.unfocus();
		} catch {
			// ignore
		}
		// Unfocus may re-engage the streaming collapse.
		applyVisibility(session);
	};

	const focusSidebar = (session: LiveSession) => {
		if (!isLive(session) || !session.overlayHandle) return;
		if (session.userHidden) {
			session.userHidden = false;
			session.overlayHandle.setHidden(false);
		}
		session.focused = true;
		pushSidebar(session, { focused: true, hiddenByUser: false });
		try {
			session.overlayHandle.focus();
		} catch {
			// ignore
		}
		// Focus expands a streaming-collapsed panel for keyboard transport.
		applyVisibility(session);
	};

	const toggleSidebar = (session: LiveSession) => {
		if (!isLive(session)) return;
		session.userHidden = !session.userHidden;
		if (session.userHidden) {
			session.focused = false;
			try {
				session.overlayHandle?.unfocus();
			} catch {
				// ignore
			}
		}
		pushSidebar(session, {
			hiddenByUser: session.userHidden,
			focused: session.focused,
		});
		applyVisibility(session);
	};

	const shutdown = async (
		session: LiveSession | null,
		clearUi?: ExtensionContext["ui"],
	) => {
		if (!session || !session.active) {
			clearUi?.setStatus(STATUS_KEY, undefined);
			clearUi?.setWidget(OVERLAY_HOST_WIDGET_KEY, undefined);
			return;
		}
		session.active = false;
		if (currentSession === session) currentSession = null;
		session.acquisitionAbort.abort();
		for (const unsubscribe of session.unsubscribers.splice(0)) unsubscribe();
		session.waveform.dispose();
		abortArtwork(session);
		session.artworkGeneration += 1;
		session.artworkFence = undefined;
		session.artwork = { kind: "empty" };
		// Widget clear disposes the host synchronously: exact handle.hide once +
		// sidebar.dispose. No unresolved custom() Promise to await.
		unmountOverlayHost(clearUi ?? session.ui);
		session.hostMounted = false;
		session.overlayHandle = undefined;
		session.sidebar = undefined;
		session.chipOverlayHandle = undefined;
		session.chip = undefined;
		if (clearUi) clearUi.setStatus(STATUS_KEY, undefined);
		else clearStatus(session);
		session.player = null;
		// Acquisition cancellation is cooperative. Never block shutdown on a
		// factory that ignores it; install() disposes any client that arrives late.
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
					if (isLive(session))
						ctx.ui.notify(sanitizeTerminalText(errMsg(error)), "error");
				},
			);
		if (session.client) return invoke(session.client);
		ctx.ui.notify("Music session is still connecting", "info");
		return Promise.resolve();
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
	pi.registerShortcut(KEY_VIEW, {
		description: "Music: toggle side panel",
		handler: async (_ctx) => {
			if (currentSession && isLive(currentSession))
				toggleSidebar(currentSession);
		},
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
	pi.registerCommand("music-view", {
		description: "Music: toggle side panel visibility",
		handler: async (_args, _ctx) => {
			if (currentSession && isLive(currentSession))
				toggleSidebar(currentSession);
		},
	});
	pi.registerCommand("music-focus", {
		description: "Music: focus side panel for transport keys",
		handler: async (_args, _ctx) => {
			if (currentSession && isLive(currentSession))
				focusSidebar(currentSession);
		},
	});
	pi.registerCommand("music-artwork", {
		description: "Music: refresh artwork for the current track",
		handler: async () => {
			const session = currentSession;
			if (
				!session ||
				!isLive(session) ||
				!session.client ||
				!session.player?.track ||
				session.artwork.kind === "loading"
			)
				return;
			requestArtwork(
				session,
				session.client,
				trackArtworkIdentity(session.player.track),
			);
		},
	});

	/**
	 * Stream-aware collapse: agent lifecycle events flip the session between
	 * full panel (idle) and compact chip (streaming). Idempotent per state.
	 */
	const setStreaming = (streaming: boolean) => {
		const session = currentSession;
		if (!session || !isLive(session)) return;
		if (session.streaming === streaming) return;
		session.streaming = streaming;
		pushSidebar(session);
		applyVisibility(session);
	};
	pi.on("agent_start", async () => setStreaming(true));
	pi.on("agent_end", async () => setStreaming(false));
	// Settled fires after retries/queued continuations; a no-op when already idle.
	pi.on("agent_settled", async () => setStreaming(false));

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
			acquisitionAbort: new AbortController(),
			clientDisposed: false,
			unsubscribers: [],
			waveform: undefined as never,
			providerNotification: undefined,
			reconnectingNotification: undefined,
			terminalNotification: undefined,
			acquisitionNotification: undefined,
			sidebar: undefined,
			overlayHandle: undefined,
			chip: undefined,
			chipOverlayHandle: undefined,
			streaming: false,
			hostMounted: false,
			userHidden: false,
			focused: false,
			artwork: { kind: "empty" },
			artworkFence: undefined,
			artworkGeneration: 0,
			artworkAbort: undefined,
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
		mountOverlayHost(session, ctx);
		const options: ReconnectingMusicSessionClientOptions = {
			clientId: `pi-music-dock-${++clientSequence}`,
			hostKind: "pi",
			capabilities: ["state-replay", "transport", "native-artwork"],
			signal: session.acquisitionAbort.signal,
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

/** Test-visible constants for the responsive overlay contract. */
export const musicSidebarOverlayContract = {
	minColumns: SIDEBAR_MIN_COLS,
	width: SIDEBAR_WIDTH,
	maxHeight: SIDEBAR_MAX_HEIGHT,
	anchor: "right-center" as const,
	nonCapturing: true,
	widgetKey: OVERLAY_HOST_WIDGET_KEY,
};

/** Test-visible constants for the compact streaming chip overlay. */
export const musicChipOverlayContract = {
	anchor: CHIP_ANCHOR,
	width: SIDEBAR_WIDTH,
	margin: CHIP_MARGIN,
	nonCapturing: true,
};
