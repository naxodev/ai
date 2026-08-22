import { expect, test } from "bun:test";
import type {
	ArtworkIdentity,
	ArtworkResult,
	MusicSessionConnectionLifecycle,
	PlayerState,
	ProviderStatus,
	ReconnectingMusicSessionClient,
	ReconnectingMusicSessionClientOptions,
	RevisionedState,
} from "@naxodev/music-core";
import {
	createMusicDock,
	musicSidebarOverlayContract,
} from "../extensions/music-dock/index.ts";
import { PNG_1X1_BASE64, PNG_1X1_BYTES } from "./artwork-fixtures.ts";

type Timer = { callback: () => void; active: boolean };

const flush = () => Promise.resolve().then(() => Promise.resolve());
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});
	return { promise, resolve, reject };
};
const player = (
	kind: "playing" | "paused" | "idle" = "playing",
	trackId = "track",
): PlayerState => ({
	is_playing: kind === "playing",
	progress_ms: 1000,
	shuffle: false,
	repeat: "off",
	device: null,
	fetched_at: 1,
	track:
		kind === "idle"
			? null
			: {
					id: trackId,
					uri: `test:${trackId}`,
					name: trackId === "track" ? "Song" : `Song ${trackId}`,
					artists: "Artist",
					album: "Album",
					duration_ms: 10_000,
				},
});

const pngBase64 = PNG_1X1_BASE64;

class FakeClient implements ReconnectingMusicSessionClient {
	daemonInstanceId = "daemon-a";
	selectedRevision = 4;
	negotiatedCapabilities = ["state-replay", "transport", "native-artwork"];
	state: RevisionedState | undefined = {
		daemonInstanceId: this.daemonInstanceId,
		revision: this.selectedRevision,
		state: player(),
	};
	status: ProviderStatus | undefined = {
		kind: "ready",
		provider: "media-control",
		message: "ready",
	};
	connection: MusicSessionConnectionLifecycle = {
		type: "connected",
		daemonInstanceId: this.daemonInstanceId,
	};
	readonly stateListeners = new Set<(state: RevisionedState) => void>();
	readonly statusListeners = new Set<(status: ProviderStatus) => void>();
	readonly connectionListeners = new Set<
		(connection: MusicSessionConnectionLifecycle) => void
	>();
	readonly calls: string[] = [];
	readonly artworkCalls: ArtworkIdentity[] = [];
	commandGate: Promise<void> | undefined;
	commandFailure: Error | undefined;
	disposeCalls = 0;
	disposeGate: Promise<void> | undefined;
	artworkResult: ArtworkResult | (() => Promise<ArtworkResult>) = {
		type: "unavailable",
	};
	artworkGate: Promise<void> | undefined;

	subscribeState(listener: (state: RevisionedState) => void) {
		this.stateListeners.add(listener);
		if (this.state) listener(this.state);
		return () => this.stateListeners.delete(listener);
	}
	subscribeStatus(listener: (status: ProviderStatus) => void) {
		this.statusListeners.add(listener);
		if (this.status) listener(this.status);
		return () => this.statusListeners.delete(listener);
	}
	subscribeConnection(
		listener: (connection: MusicSessionConnectionLifecycle) => void,
	) {
		this.connectionListeners.add(listener);
		listener(this.connection);
		return () => this.connectionListeners.delete(listener);
	}
	emitState(
		next: PlayerState,
		revision = ++this.selectedRevision,
		daemon = this.daemonInstanceId,
	) {
		this.state = { daemonInstanceId: daemon, revision, state: next };
		this.daemonInstanceId = daemon;
		for (const listener of [...this.stateListeners]) listener(this.state);
	}
	emitStatus(next: ProviderStatus) {
		this.status = next;
		for (const listener of [...this.statusListeners]) listener(next);
	}
	emitConnection(next: MusicSessionConnectionLifecycle) {
		this.connection = next;
		for (const listener of [...this.connectionListeners]) listener(next);
	}
	private async command(action: string) {
		this.calls.push(action);
		await this.commandGate;
		if (this.commandFailure) throw this.commandFailure;
		return { action } as never;
	}
	toggle() {
		return this.command("toggle");
	}
	play() {
		return this.command("play");
	}
	pause() {
		return this.command("pause");
	}
	next() {
		return this.command("next");
	}
	previous() {
		return this.command("previous");
	}
	seek(positionMs: number) {
		return this.command(`seek:${positionMs}`);
	}
	async artwork(identity: ArtworkIdentity) {
		this.artworkCalls.push(identity);
		await this.artworkGate;
		const result = this.artworkResult;
		return typeof result === "function" ? result() : result;
	}
	async dispose() {
		this.disposeCalls++;
		await this.disposeGate;
	}
}

/**
 * Models real Pi TUI overlay behavior:
 * - showOverlay returns a handle
 * - handle.hide() removes the overlay only (does NOT resolve any custom Promise)
 * - setWidget(key, factory) creates the host; setWidget(key, undefined) disposes it
 * - No ctx.ui.custom path for the persistent panel
 */
type OverlayHandleMock = {
	hide: () => void;
	setHidden: (hidden: boolean) => void;
	isHidden: () => boolean;
	focus: () => void;
	unfocus: () => void;
	isFocused: () => boolean;
	hidden: boolean;
	focused: boolean;
	hideCalls: number;
};

type HostRecord = {
	key: string;
	component: { dispose?: () => void; render: (w: number) => string[] };
	disposeCalls: number;
};

type OverlayRecord = {
	component: any;
	options: any;
	handle: OverlayHandleMock;
	hiddenByHide: boolean;
};

function setup(
	createClient: (
		options: ReconnectingMusicSessionClientOptions,
	) => Promise<ReconnectingMusicSessionClient>,
	extras: {
		fetch?: (
			input: string | URL | Request,
			init?: RequestInit,
		) => Promise<Response>;
	} = {},
) {
	let start: ((event: unknown, ctx: any) => Promise<void>) | undefined;
	let shutdown: ((event: unknown, ctx: any) => Promise<void>) | undefined;
	const intervals: Timer[] = [];
	const statuses: Array<string | undefined> = [];
	const themedText: string[] = [];
	const notifications: string[] = [];
	const commands: Record<
		string,
		{ handler: (args: string, ctx: any) => Promise<void> }
	> = {};
	const shortcuts: Array<{
		description?: string;
		handler: (ctx: any) => Promise<void>;
	}> = [];
	const hosts = new Map<string, HostRecord>();
	const overlays: OverlayRecord[] = [];
	const terminalWrites: string[] = [];
	// A second overlay that could exist alongside the music panel.
	const foreignOverlay = {
		handle: null as OverlayHandleMock | null,
		hideCalls: 0,
	};

	const makeHandle = (): OverlayHandleMock => {
		const handle: OverlayHandleMock = {
			hidden: false,
			focused: false,
			hideCalls: 0,
			hide() {
				// Real Pi: hide removes the overlay from the TUI only.
				// It does not dispose the host widget or resolve a custom Promise.
				handle.hideCalls++;
				handle.hidden = true;
				handle.focused = false;
			},
			setHidden(hidden: boolean) {
				handle.hidden = hidden;
				if (hidden) handle.focused = false;
			},
			isHidden() {
				return handle.hidden;
			},
			focus() {
				handle.focused = true;
				handle.hidden = false;
			},
			unfocus() {
				handle.focused = false;
			},
			isFocused() {
				return handle.focused;
			},
		};
		return handle;
	};

	const tui = {
		requestRender: () => {},
		terminal: {
			write: (data: string) => {
				terminalWrites.push(data);
			},
		},
		showOverlay: (component: any, options?: any) => {
			const handle = makeHandle();
			overlays.push({
				component,
				options,
				handle,
				hiddenByHide: false,
			});
			const originalHide = handle.hide.bind(handle);
			handle.hide = () => {
				originalHide();
				const record = overlays.find((item) => item.handle === handle);
				if (record) record.hiddenByHide = true;
			};
			return handle;
		},
	};

	const ui = {
		setStatus: (_key: string, value: string | undefined) =>
			statuses.push(value),
		theme: {
			fg: (_color: string, value: string) => {
				themedText.push(value);
				return value;
			},
		},
		notify: (message: string) => notifications.push(message),
		setWidget: (
			key: string,
			content:
				| ((
						tuiArg: any,
						theme: any,
				  ) => {
						dispose?: () => void;
						render: (w: number) => string[];
				  })
				| undefined,
		) => {
			// Mirror Pi: dispose existing host for this key before replace/clear.
			const existing = hosts.get(key);
			if (existing) {
				existing.component.dispose?.();
				existing.disposeCalls++;
				hosts.delete(key);
			}
			if (content === undefined) return;
			const component = content(tui, ui.theme);
			hosts.set(key, { key, component, disposeCalls: 0 });
		},
		// Intentionally no custom() — persistent panel must not use it.
	};

	const ctx = { mode: "tui", hasUI: true, ui };
	createMusicDock(
		{
			registerShortcut: (_key: unknown, shortcut: any) =>
				shortcuts.push(shortcut),
			registerCommand: (name: string, command: any) => {
				commands[name] = command;
			},
			on: (name: string, handler: any) => {
				if (name === "session_start") start = handler;
				if (name === "session_shutdown") shutdown = handler;
			},
		} as never,
		{
			createClient,
			now: () => 1,
			// Default fetch never hits the network — catalog tests inject their own.
			fetch:
				extras.fetch ??
				(async () => {
					throw new Error("network disabled in dock tests");
				}),
			setInterval: (callback) => {
				const timer = { callback, active: true };
				intervals.push(timer);
				return timer as never;
			},
			clearInterval: (timer) => {
				(timer as unknown as Timer).active = false;
			},
		},
	);

	// Simulate another extension overlay that must not be confused with ours.
	foreignOverlay.handle = makeHandle();
	const foreignHide = foreignOverlay.handle.hide.bind(foreignOverlay.handle);
	foreignOverlay.handle.hide = () => {
		foreignHide();
		foreignOverlay.hideCalls++;
	};

	return {
		start: (context: any = ctx) => start?.({}, context),
		shutdown: (context: any = ctx) => shutdown?.({}, context),
		command: (name: string, context: any = ctx) =>
			commands[name]!.handler("", context),
		shortcut: (index: number, context: any = ctx) =>
			shortcuts[index]!.handler(context),
		shortcutByDescription: (fragment: string, context: any = ctx) => {
			const match = shortcuts.find((item) =>
				item.description?.includes(fragment),
			);
			return match!.handler(context);
		},
		statuses,
		themedText,
		notifications,
		intervals,
		hosts,
		overlays,
		terminalWrites,
		foreignOverlay,
		activeIntervals: () => intervals.filter((timer) => timer.active),
		context: ctx,
		commands,
		shortcuts,
		musicHost: () => hosts.get(musicSidebarOverlayContract.widgetKey),
		musicOverlay: () =>
			overlays.find((item) =>
				item.component ===
				hosts.get(musicSidebarOverlayContract.widgetKey)?.component
					? false
					: true,
			) ?? overlays.at(-1),
	};
}

test("session client is created only for a live TUI start with Pi capabilities including native-artwork", async () => {
	// Why: one reconnecting client per live TUI session is the ownership model.
	// native-artwork is negotiated here so artwork() is legal without a second client.
	const client = new FakeClient();
	const options: ReconnectingMusicSessionClientOptions[] = [];
	const dock = setup(async (next) => {
		options.push(next);
		return client;
	});
	expect(options).toHaveLength(0);
	await dock.start({ mode: "json", hasUI: false, ui: dock.context.ui });
	expect(options).toHaveLength(0);
	await dock.start();
	await flush();
	expect(options).toHaveLength(1);
	expect(options[0]).toMatchObject({
		clientId: expect.stringMatching(/^pi-music-dock-/),
		hostKind: "pi",
		capabilities: ["state-replay", "transport", "native-artwork"],
	});
	expect(options[0]!.signal).toBeInstanceOf(AbortSignal);
	expect(client.stateListeners.size).toBe(1);
	expect(client.statusListeners.size).toBe(1);
	expect(client.connectionListeners.size).toBe(1);
	await dock.shutdown();
});

test("status metadata is sanitized before theme rendering", async () => {
	// Why: a media title can contain OSC 52, ANSI, and layout controls supplied
	// by another process. The status line must retain safe Unicode only.
	const client = new FakeClient();
	client.state = undefined;
	const dock = setup(async () => client);
	await dock.start();
	await flush();
	client.emitState({
		...player(),
		track: {
			...player().track!,
			name: "Café 🎵\x1b]52;c;YXR0YWNr\x07\x1b[31m\nnext",
			artists: "Art\tist\x9d52;c;ZXZpbA\x9c",
		},
	});
	const themedStatus = dock.themedText.at(-1)!;
	expect(themedStatus).toBe("Café 🎵next · Artist");
	expect(themedStatus).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
	expect(themedStatus).not.toContain("]52;");
	expect(themedStatus).not.toContain("[31m");
	client.emitStatus({
		kind: "degraded",
		provider: "media-control",
		message: "lost\x1b]52;c;YXR0YWNr\x07\x1b[31m\nprovider",
	});
	expect(dock.notifications.at(-1)).toBe("lostprovider");
	await dock.shutdown();
});

test("panel mounts via setWidget host + showOverlay with responsive nonCapturing contract", async () => {
	// Why: Pi 0.84 custom() only resolves on done(); hide() does not. A persistent
	// panel must own showOverlay from a widget host so shutdown never hangs.
	const client = new FakeClient();
	const dock = setup(async () => client);
	await dock.start();
	await flush();
	expect(dock.hosts.has(musicSidebarOverlayContract.widgetKey)).toBe(true);
	expect(dock.overlays).toHaveLength(1);
	const options = dock.overlays[0]!.options;
	expect(options).toMatchObject({
		anchor: musicSidebarOverlayContract.anchor,
		width: musicSidebarOverlayContract.width,
		maxHeight: musicSidebarOverlayContract.maxHeight,
		nonCapturing: musicSidebarOverlayContract.nonCapturing,
	});
	// Why: Herdr commonly allocates 82-column split panes even when the tab is
	// zoomed. Keep the 30-column panel visible there while preserving 50
	// columns for the transcript; narrower panes still auto-hide it.
	expect(options.visible(80, 40)).toBe(true);
	expect(options.visible(79, 40)).toBe(false);
	// Host contributes no editor chrome.
	expect(dock.musicHost()!.component.render(40)).toEqual([]);
	await dock.shutdown();
});

test("music-view and ctrl+alt+m toggle visibility; music-focus focuses the panel", async () => {
	// Why: users need hide/show and focus without a second overlay instance.
	const client = new FakeClient();
	const dock = setup(async () => client);
	await dock.start();
	await flush();
	const handle = dock.overlays[0]!.handle;
	expect(handle.hidden).toBe(false);

	await dock.command("music-view");
	expect(handle.hidden).toBe(true);
	expect(dock.overlays[0]!.options.visible(120, 40)).toBe(false);

	await dock.shortcutByDescription("side panel");
	expect(handle.hidden).toBe(false);

	await dock.command("music-focus");
	expect(handle.focused).toBe(true);
	expect(handle.hidden).toBe(false);
	await dock.shutdown();
});

test("focused panel keys delegate transport exactly once through the same client", async () => {
	// Why: Space/arrows while focused must not invent a second transport path.
	const client = new FakeClient();
	const dock = setup(async () => client);
	await dock.start();
	await flush();
	await dock.command("music-focus");
	const component = dock.overlays[0]!.component;
	component.handleInput(" ");
	component.handleInput("\x1b[C");
	component.handleInput("\x1b[D");
	await flush();
	expect(client.calls).toEqual(["toggle", "next", "previous"]);
	component.handleInput("\x1b");
	expect(dock.overlays[0]!.handle.focused).toBe(false);
	await dock.shutdown();
});

test("initial acquisition failure becomes bounded Pi feedback", async () => {
	const dock = setup(async () => {
		throw new Error("incompatible daemon");
	});
	await dock.start();
	await flush();
	expect(dock.notifications).toEqual(["incompatible daemon"]);
	await dock.shutdown();
});

test("replay, replacement, reconnect, provider feedback, and terminal state stay session authoritative", async () => {
	const client = new FakeClient();
	const dock = setup(async () => client);
	await dock.start();
	await flush();
	expect(dock.statuses.at(-1)).toContain("⏸");
	client.emitState(player("paused"));
	expect(dock.statuses.at(-1)).toContain("▶");
	client.emitState(player("idle"));
	expect(dock.statuses.at(-1)).toBeUndefined();
	client.emitState(player(), 1, "daemon-b");
	expect(dock.statuses.at(-1)).toContain("Song");
	client.emitConnection({
		type: "reconnecting",
		error: { message: "reconnecting" } as never,
	});
	expect(dock.statuses.at(-1)).toContain("Song");
	client.emitStatus({
		kind: "unavailable",
		provider: "media-control",
		message: "unavailable",
	});
	client.emitConnection({
		type: "terminal",
		error: { message: "incompatible" } as never,
	});
	client.emitStatus({
		kind: "degraded",
		provider: "media-control",
		message: "degraded",
	});
	client.emitStatus({
		kind: "ready",
		provider: "media-control",
		message: "ready",
	});
	client.emitStatus({
		kind: "degraded",
		provider: "media-control",
		message: "degraded",
	});
	client.emitConnection({ type: "connected", daemonInstanceId: "daemon-b" });
	client.emitConnection({
		type: "reconnecting",
		error: { message: "reconnecting" } as never,
	});
	client.emitConnection({
		type: "terminal",
		error: { message: "reconnecting" } as never,
	});
	expect(dock.notifications).toEqual([
		"reconnecting",
		"unavailable",
		"incompatible",
		"degraded",
		"degraded",
		"reconnecting",
		"reconnecting",
	]);
	await dock.shutdown();
});

test("commands and shortcuts delegate immediately once through the client", async () => {
	const client = new FakeClient();
	const gate = deferred<void>();
	client.commandGate = gate.promise;
	const dock = setup(async () => client);
	await dock.start();
	await flush();
	const calls = [
		dock.command("music"),
		dock.command("music-next"),
		dock.command("music-prev"),
		dock.shortcut(0),
		dock.shortcut(1),
		dock.shortcut(2),
	];
	expect(client.calls).toEqual([
		"toggle",
		"next",
		"previous",
		"toggle",
		"next",
		"previous",
	]);
	gate.resolve();
	await Promise.all(calls);
	await dock.shutdown();
});

test("commands never queue behind client acquisition", async () => {
	const pending = deferred<ReconnectingMusicSessionClient>();
	const client = new FakeClient();
	const dock = setup(async () => pending.promise);
	await dock.start();
	const issued = dock.command("music-next");
	expect(client.calls).toEqual([]);
	expect(dock.notifications).toContain("Music session is still connecting");
	pending.resolve(client);
	await issued;
	expect(client.calls).toEqual([]);
	await dock.shutdown();

	const oldPending = deferred<ReconnectingMusicSessionClient>();
	const old = new FakeClient();
	const replacement = new FakeClient();
	let factories = 0;
	const reloadingDock = setup(async () =>
		++factories === 1 ? oldPending.promise : replacement,
	);
	await reloadingDock.start();
	const oldCommand = reloadingDock.command("music-next");
	const reloading = reloadingDock.start();
	oldPending.resolve(old);
	await reloading;
	await oldCommand;
	expect(old.calls).toEqual([]);
	expect(replacement.calls).toEqual([]);
	await reloadingDock.shutdown();
});

test("each rejected live command notifies its caller once", async () => {
	const client = new FakeClient();
	client.commandFailure = new Error(
		"command \x1b]52;c;YXR0YWNr\x07\x1b[31m\nfailed",
	);
	const dock = setup(async () => client);
	await dock.start();
	await flush();
	await Promise.all([dock.command("music-next"), dock.command("music-prev")]);
	expect(dock.notifications).toEqual(["command failed", "command failed"]);
	await dock.shutdown();
});

test("provider failure falls back to catalog art and paints ready presentation", async () => {
	// Why: media-control often fails native art (~1.5MB beyond daemon bound).
	// Without catalog fallback the live panel shows "no artwork" for real tracks.
	const client = new FakeClient();
	client.state = {
		daemonInstanceId: client.daemonInstanceId,
		revision: client.selectedRevision,
		state: {
			...player(),
			track: {
				...player().track!,
				album: "",
				duration_ms: 0,
			},
		},
	};
	client.artworkResult = async () => {
		throw new Error("PROVIDER_FAILURE");
	};
	const dock = setup(async () => client, {
		fetch: async (input) => {
			const href = String(input);
			if (href.includes("itunes.apple.com/search")) {
				return new Response(
					JSON.stringify({
						results: [
							{
								trackName: "Song",
								artistName: "Artist",
								collectionName: "Album",
								trackTimeMillis: 10_000,
								artworkUrl100:
									"https://is1-ssl.mzstatic.com/image/100x100bb.jpg",
							},
						],
					}),
					{ status: 200 },
				);
			}
			if (href.includes("mzstatic.com")) {
				return new Response(PNG_1X1_BYTES, { status: 200 });
			}
			throw new Error(`unexpected ${href}`);
		},
	});
	await dock.start();
	await flush();
	// Allow catalog chain to settle.
	await Bun.sleep(10);
	await flush();
	const rendered = dock.overlays[0]!.component.render(30).join("\n");
	expect(rendered).not.toContain("no artwork");
	expect(rendered).not.toContain("loading art");
	expect(rendered).toContain("Song");
	// Catalog metadata never replaces daemon-owned playback duration.
	expect(rendered).toContain("/ 0:00");
	await dock.shutdown();
});

test("replacement aborts in-flight catalog fallback so late art cannot paint", async () => {
	// Why: generation + AbortController must fence catalog completions the same
	// way native artwork is fenced — otherwise track B shows track A's cover.
	const client = new FakeClient();
	const nativeGate = deferred<void>();
	client.artworkResult = async () => {
		await nativeGate.promise;
		throw new Error("PROVIDER_FAILURE");
	};
	let catalogStarts = 0;
	const catalogGate = deferred<void>();
	const dock = setup(async () => client, {
		fetch: async (input) => {
			const href = String(input);
			if (href.includes("itunes.apple.com/search")) {
				catalogStarts++;
				await catalogGate.promise;
				return new Response(
					JSON.stringify({
						results: [
							{
								trackName: "Song",
								artistName: "Artist",
								collectionName: "Album",
								trackTimeMillis: 10_000,
								artworkUrl100:
									"https://is1-ssl.mzstatic.com/image/100x100bb.jpg",
							},
						],
					}),
					{ status: 200 },
				);
			}
			return new Response(PNG_1X1_BYTES, { status: 200 });
		},
	});
	await dock.start();
	await flush();
	// Start first artwork (still gated on native).
	expect(client.artworkCalls).toHaveLength(1);
	// Replace track before native resolves — aborts generation 1.
	client.artworkResult = { type: "unavailable" };
	client.artworkGate = undefined;
	client.emitState(player("playing", "track-b"));
	await flush();
	nativeGate.resolve();
	catalogGate.resolve();
	await flush();
	await Bun.sleep(10);
	await flush();
	// Second track may catalog-fail to unavailable (network disabled path after
	// identity change uses unavailable native + our fetch). Either way the first
	// generation must not paint over track-b metadata.
	const rendered = dock.overlays[0]!.component.render(30).join("\n");
	expect(rendered).toContain("Song track-b");
	await dock.shutdown();
	// Catalog for the aborted first generation should not complete a paint;
	// starts may be 0 (aborted before fallback) or 1 (started then aborted).
	expect(catalogStarts).toBeLessThanOrEqual(1);
});

test("stale artwork cannot overwrite a replacement track or session", async () => {
	// Why: artwork is async and non-replayable. A late completion for track A
	// after the user skipped to track B (or reloaded) must not paint the panel.
	const client = new FakeClient();
	const gate = deferred<void>();
	client.artworkGate = gate.promise;
	client.artworkResult = { type: "available", base64: pngBase64 };
	const dock = setup(async () => client);
	await dock.start();
	await flush();
	expect(client.artworkCalls).toHaveLength(1);
	expect(client.artworkCalls[0]?.id).toBe("track");

	const secondGate = deferred<void>();
	client.artworkGate = secondGate.promise;
	client.artworkResult = {
		type: "available",
		base64: pngBase64,
	};
	client.emitState(player("playing", "track-b"));
	await flush();
	expect(client.artworkCalls).toHaveLength(2);

	gate.resolve();
	await flush();
	const component = dock.overlays[0]!.component;
	expect(client.artworkCalls[1]?.id).toBe("track-b");

	secondGate.resolve();
	await flush();
	const after = component.render(30).join("\n");
	expect(after).toContain("Song track-b");

	const late = deferred<void>();
	client.artworkGate = late.promise;
	client.emitState(player("playing", "track-c"));
	await flush();
	await dock.start();
	await flush();
	late.resolve();
	await flush();
	client.emitState(player("paused", "track-c"));
	await dock.shutdown();
});

test("reload/shutdown returns promptly, hides the exact host overlay once, and leaves foreign overlays alone", async () => {
	// Why: hide() only removes the TUI overlay — it does not complete a custom()
	// Promise. The host is disposed by clearing the widget key synchronously, so
	// reload/shutdown must return without awaiting any done() callback. A foreign
	// overlay that happens to exist must not be hidden.
	const old = new FakeClient();
	const replacement = new FakeClient();
	let factories = 0;
	const dock = setup(async () => (++factories === 1 ? old : replacement));
	await dock.start();
	await flush();
	expect(dock.overlays).toHaveLength(1);
	const firstHandle = dock.overlays[0]!.handle;
	const firstHost = dock.musicHost();
	expect(firstHost).toBeDefined();
	const foreignBefore = dock.foreignOverlay.hideCalls;

	const reloading = dock.start();
	await Promise.race([
		reloading,
		Bun.sleep(200).then(() => {
			throw new Error("reload hung — custom() promise still awaited?");
		}),
	]);
	await flush();
	expect(firstHandle.hideCalls).toBe(1);
	expect(old.disposeCalls).toBe(1);
	expect(factories).toBe(2);
	expect(dock.overlays.length).toBe(2);
	expect(firstHandle.hideCalls).toBe(1);
	expect(dock.foreignOverlay.hideCalls).toBe(foreignBefore);
	// Host for the old key was disposed via setWidget clear (tracked as remove).
	expect(dock.hosts.has(musicSidebarOverlayContract.widgetKey)).toBe(true);

	const statusCount = dock.statuses.length;
	old.emitState(player("paused"));
	expect(dock.statuses).toHaveLength(statusCount);
	expect(replacement.stateListeners.size).toBe(1);

	const secondHandle = dock.overlays.at(-1)!.handle;
	const shutting = dock.shutdown();
	await Promise.race([
		shutting,
		Bun.sleep(200).then(() => {
			throw new Error("shutdown hung — custom() promise still awaited?");
		}),
	]);
	expect(secondHandle.hideCalls).toBe(1);
	expect(replacement.disposeCalls).toBe(1);
	expect(dock.hosts.has(musicSidebarOverlayContract.widgetKey)).toBe(false);
	expect(dock.foreignOverlay.hideCalls).toBe(foreignBefore);
});

test("shutdown during acquisition disposes the late client and fences all feedback", async () => {
	const pending = deferred<ReconnectingMusicSessionClient>();
	const client = new FakeClient();
	const dock = setup(async () => pending.promise);
	await dock.start();
	const stopping = dock.shutdown();
	pending.resolve(client);
	await Promise.race([
		stopping,
		Bun.sleep(200).then(() => {
			throw new Error("shutdown hung during acquisition");
		}),
	]);
	client.emitStatus({
		kind: "unavailable",
		provider: "media-control",
		message: "late unavailable",
	});
	client.emitConnection({
		type: "terminal",
		error: { message: "late terminal" } as never,
	});
	client.emitState(player("paused"));
	await flush();
	expect(client.disposeCalls).toBe(1);
	expect(client.stateListeners.size).toBe(0);
	expect(dock.notifications).toEqual([]);
	expect(dock.statuses.at(-1)).toBeUndefined();
	expect(dock.overlays[0]!.handle.hideCalls).toBe(1);
});

test("shutdown aborts a non-settling client acquisition and completes promptly", async () => {
	// Why: daemon discovery may wait indefinitely. Session shutdown must be able
	// to stop the factory instead of awaiting work that only it can cancel.
	let observedSignal: AbortSignal | undefined;
	let observedAbort = false;
	const dock = setup(
		(options) =>
			new Promise<ReconnectingMusicSessionClient>((_resolve, reject) => {
				observedSignal = options.signal;
				options.signal?.addEventListener(
					"abort",
					() => {
						observedAbort = true;
						reject(options.signal?.reason);
					},
					{ once: true },
				);
			}),
	);
	await dock.start();
	await flush();
	expect(observedSignal?.aborted).toBe(false);

	await Promise.race([
		dock.shutdown(),
		Bun.sleep(200).then(() => {
			throw new Error("shutdown did not cancel client acquisition");
		}),
	]);
	expect(observedAbort).toBe(true);
	expect(observedSignal?.aborted).toBe(true);
});

test("shutdown does not await a client factory that ignores abort", async () => {
	// Why: cancellation is cooperative. An injected or buggy factory may ignore
	// its signal forever, but Pi shutdown must still release all owned UI work.
	let observedSignal: AbortSignal | undefined;
	const dock = setup((options) => {
		observedSignal = options.signal;
		return new Promise<ReconnectingMusicSessionClient>(() => {});
	});
	await dock.start();
	await flush();
	expect(observedSignal?.aborted).toBe(false);

	await Promise.race([
		dock.shutdown(),
		Bun.sleep(200).then(() => {
			throw new Error("shutdown awaited an abort-ignoring client factory");
		}),
	]);
	expect(observedSignal?.aborted).toBe(true);
	expect(dock.overlays[0]!.handle.hideCalls).toBe(1);
});

test("reload fences a held old-generation command without delaying the replacement", async () => {
	const old = new FakeClient();
	const replacement = new FakeClient();
	const gate = deferred<void>();
	old.commandGate = gate.promise;
	let factories = 0;
	const dock = setup(async () => (++factories === 1 ? old : replacement));
	await dock.start();
	await flush();
	const active = dock.command("music-next");
	await dock.start();
	await flush();
	expect(factories).toBe(2);
	old.commandFailure = new Error("old failure");
	gate.resolve();
	await active;
	expect(dock.notifications).toEqual([]);
	expect(replacement.stateListeners.size).toBe(1);
	await dock.shutdown();
});

test("shutdown fences held commands, clears status and waveform work, and disposes once", async () => {
	const client = new FakeClient();
	const gate = deferred<void>();
	client.commandGate = gate.promise;
	const dock = setup(async () => client);
	await dock.start();
	await flush();
	expect(dock.activeIntervals()).toHaveLength(1);
	const active = dock.command("music-next");
	await dock.shutdown();
	expect(dock.activeIntervals()).toHaveLength(0);
	expect(dock.statuses.at(-1)).toBeUndefined();
	const notifications = dock.notifications.length;
	client.commandFailure = new Error("late command");
	gate.resolve();
	await active;
	client.emitState(player("paused"));
	await flush();
	expect(dock.notifications).toHaveLength(notifications);
	expect(client.disposeCalls).toBe(1);
});
