import { expect, test } from "bun:test";
import type {
	MusicSessionConnectionLifecycle,
	PlayerState,
	ProviderStatus,
	ReconnectingMusicSessionClient,
	ReconnectingMusicSessionClientOptions,
	RevisionedState,
} from "@naxodev/music-core";
import { createMusicDock } from "../extensions/music-dock/index.ts";

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
					id: "track",
					uri: "test:track",
					name: "Song",
					artists: "Artist",
					album: "Album",
					duration_ms: 10_000,
				},
});

class FakeClient implements ReconnectingMusicSessionClient {
	daemonInstanceId = "daemon-a";
	selectedRevision = 4;
	negotiatedCapabilities = ["state-replay", "transport"];
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
	commandGate: Promise<void> | undefined;
	commandFailure: Error | undefined;
	disposeCalls = 0;
	disposeGate: Promise<void> | undefined;

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
	async artwork() {
		return { type: "unavailable" } as never;
	}
	async dispose() {
		this.disposeCalls++;
		await this.disposeGate;
	}
}

function setup(
	createClient: (
		options: ReconnectingMusicSessionClientOptions,
	) => Promise<ReconnectingMusicSessionClient>,
) {
	let start: ((event: unknown, ctx: any) => Promise<void>) | undefined;
	let shutdown: ((event: unknown, ctx: any) => Promise<void>) | undefined;
	const intervals: Timer[] = [];
	const statuses: Array<string | undefined> = [];
	const notifications: string[] = [];
	const commands: Record<
		string,
		{ handler: (args: string, ctx: any) => Promise<void> }
	> = {};
	const shortcuts: Array<{ handler: (ctx: any) => Promise<void> }> = [];
	const ui = {
		setStatus: (_key: string, value: string | undefined) =>
			statuses.push(value),
		theme: { fg: (_color: string, value: string) => value },
		notify: (message: string) => notifications.push(message),
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
	return {
		start: (context: any = ctx) => start?.({}, context),
		shutdown: (context: any = ctx) => shutdown?.({}, context),
		command: (name: string, context: any = ctx) =>
			commands[name]!.handler("", context),
		shortcut: (index: number, context: any = ctx) =>
			shortcuts[index]!.handler(context),
		statuses,
		notifications,
		intervals,
		activeIntervals: () => intervals.filter((timer) => timer.active),
		context: ctx,
	};
}

test("session client is created only for a live TUI start with Pi capabilities", async () => {
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
		capabilities: ["state-replay", "transport"],
	});
	expect(client.stateListeners.size).toBe(1);
	expect(client.statusListeners.size).toBe(1);
	expect(client.connectionListeners.size).toBe(1);
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

test("commands wait for their live acquisition and never cross into a replacement", async () => {
	const pending = deferred<ReconnectingMusicSessionClient>();
	const client = new FakeClient();
	const dock = setup(async () => pending.promise);
	await dock.start();
	const issued = dock.command("music-next");
	expect(client.calls).toEqual([]);
	pending.resolve(client);
	await issued;
	expect(client.calls).toEqual(["next"]);
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
	client.commandFailure = new Error("command failed");
	const dock = setup(async () => client);
	await dock.start();
	await flush();
	await Promise.all([dock.command("music-next"), dock.command("music-prev")]);
	expect(dock.notifications).toEqual(["command failed", "command failed"]);
	await dock.shutdown();
});

test("reload waits for pending acquisition, disposes the old client once, and fences late callbacks", async () => {
	const pending = deferred<ReconnectingMusicSessionClient>();
	const old = new FakeClient();
	const replacement = new FakeClient();
	let factories = 0;
	const dock = setup(async () =>
		++factories === 1 ? pending.promise : replacement,
	);
	await dock.start();
	const reloading = dock.start();
	await flush();
	expect(factories).toBe(1);
	pending.resolve(old);
	await reloading;
	await flush();
	expect(old.disposeCalls).toBe(1);
	expect(factories).toBe(2);
	const statusCount = dock.statuses.length;
	old.emitState(player("paused"));
	expect(dock.statuses).toHaveLength(statusCount);
	expect(replacement.stateListeners.size).toBe(1);
	await dock.shutdown();
	expect(replacement.disposeCalls).toBe(1);
});

test("shutdown during acquisition disposes the late client and fences all feedback", async () => {
	const pending = deferred<ReconnectingMusicSessionClient>();
	const client = new FakeClient();
	const dock = setup(async () => pending.promise);
	await dock.start();
	const stopping = dock.shutdown();
	pending.resolve(client);
	await stopping;
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
