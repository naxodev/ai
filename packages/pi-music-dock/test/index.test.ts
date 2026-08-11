import { expect, test } from "bun:test";
import type {
	MusicBackend,
	MusicChangeEvent,
	PlayerState,
} from "@naxodev/music-core";
import { createMusicDock } from "../extensions/music-dock/index.ts";

type Timer = { callback: () => void; delay: number; active: boolean };

function state(kind: "playing" | "paused" | "idle" = "playing"): PlayerState {
	return {
		is_playing: kind === "playing",
		progress_ms: 0,
		shuffle: false,
		repeat: "off",
		device: null,
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
		fetched_at: Date.now(),
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

type SetupOptions = { controllableSleep?: boolean };

async function flushRefresh(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function setup(backend: MusicBackend, options: SetupOptions = {}) {
	let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
	let shutdown: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
	const timeouts: Timer[] = [];
	const intervals: Timer[] = [];
	const sleeps: Array<{
		delay: number;
		resolve: () => void;
		reject: (reason: unknown) => void;
	}> = [];
	const statuses: Array<string | undefined> = [];
	const notifications: string[] = [];
	const commands: Record<
		string,
		{ handler: (args: string, ctx: unknown) => Promise<void> }
	> = {};
	const shortcuts: Array<{ handler: (ctx: unknown) => Promise<void> }> = [];
	const ui = {
		setStatus: (_key: string, value: string | undefined) =>
			statuses.push(value),
		theme: { fg: (_color: string, value: string) => value },
		notify: (message: string) => notifications.push(message),
	};
	const api = {
		registerShortcut: (_key: unknown, shortcut: (typeof shortcuts)[number]) => {
			shortcuts.push(shortcut);
		},
		registerCommand: (name: string, command: (typeof commands)[string]) => {
			commands[name] = command;
		},
		on: (
			name: string,
			handler: (event: unknown, ctx: unknown) => Promise<void>,
		) => {
			if (name === "session_start") start = handler;
			if (name === "session_shutdown") shutdown = handler;
		},
	};
	createMusicDock(api as never, {
		backend,
		isMac: () => true,
		hasMediaControl: () => true,
		hasNowPlayingCli: () => false,
		setTimeout: (callback, delay) => {
			const timer = { callback, delay, active: true };
			timeouts.push(timer);
			return timer as never;
		},
		clearTimeout: (timer) => {
			(timer as unknown as Timer).active = false;
		},
		setInterval: (callback, delay) => {
			const timer = { callback, delay, active: true };
			intervals.push(timer);
			return timer as never;
		},
		clearInterval: (timer) => {
			(timer as unknown as Timer).active = false;
		},
		sleep: (delay) => {
			if (!options.controllableSleep) return Promise.resolve();
			const pending = deferred<void>();
			sleeps.push({
				delay,
				resolve: () => pending.resolve(),
				reject: pending.reject,
			});
			return pending.promise;
		},
	});
	const ctx = { mode: "tui", hasUI: true, ui };
	return {
		start: (context: unknown = ctx) => start?.({}, context),
		shutdown: (context: unknown = ctx) => shutdown?.({}, context),
		timeouts,
		intervals,
		sleeps,
		statuses,
		notifications,
		command: (name: string) => commands[name]!.handler("", ctx),
		shortcut: (index: number) => shortcuts[index]!.handler(ctx),
		activeTimeouts: () => timeouts.filter((timer) => timer.active),
	};
}

async function expectSettled(promise: Promise<void>) {
	let settled = false;
	void promise.then(() => {
		settled = true;
	});
	await flushRefresh();
	expect(settled).toBeTrue();
}

test("starts, subscribes, and polls at the playing bound", async () => {
	let listener: (() => void) | undefined;
	let subscriptions = 0;
	const backend: MusicBackend = {
		id: "fake",
		label: "Fake",
		remoteControl: false,
		authenticated: () => true,
		player: async () => state(),
		play: async () => {},
		subscribe: (next) => {
			subscriptions++;
			listener = next;
			return () => {
				listener = undefined;
			};
		},
	};
	const dock = setup(backend);
	await dock.start();
	expect(subscriptions).toBe(1);
	expect(dock.activeTimeouts().map((timer) => timer.delay)).toEqual([3_000]);
	listener?.();
	await flushRefresh();
	expect(dock.activeTimeouts()).toHaveLength(1);
});

test("serializes event bursts into one catch-up sample", async () => {
	let listener: (() => void) | undefined;
	const first = deferred<PlayerState | null>();
	const second = deferred<PlayerState | null>();
	let calls = 0;
	const backend: MusicBackend = {
		id: "fake",
		label: "Fake",
		remoteControl: false,
		authenticated: () => true,
		player: () => (++calls === 1 ? first.promise : second.promise),
		play: async () => {},
		subscribe: (next) => {
			listener = next;
			return () => {};
		},
	};
	const dock = setup(backend);
	void dock.start();
	listener?.();
	listener?.();
	expect(calls).toBe(1);
	first.resolve(state());
	await flushRefresh();
	expect(calls).toBe(2);
	second.resolve(state());
});

test("reschedules polling for event-driven paused and idle states", async () => {
	let listener: (() => void) | undefined;
	const samples = [state(), state("paused"), state("idle")];
	const backend: MusicBackend = {
		id: "fake",
		label: "Fake",
		remoteControl: false,
		authenticated: () => true,
		player: async () => samples.shift() ?? state("idle"),
		play: async () => {},
		subscribe: (next) => {
			listener = next;
			return () => {};
		},
	};
	const dock = setup(backend);
	await dock.start();
	listener?.();
	await flushRefresh();
	expect(dock.activeTimeouts().map((timer) => timer.delay)).toEqual([5_000]);
	listener?.();
	await flushRefresh();
	expect(dock.activeTimeouts().map((timer) => timer.delay)).toEqual([8_000]);
});

test("a pre-transport event sample cannot undo optimistic playback", async () => {
	let listener: (() => void) | undefined;
	const stale = deferred<PlayerState | null>();
	const fresh = deferred<PlayerState | null>();
	let calls = 0;
	const backend: MusicBackend = {
		id: "fake",
		label: "Fake",
		remoteControl: false,
		authenticated: () => true,
		player: () => {
			calls++;
			if (calls === 1) return Promise.resolve(state("paused"));
			return calls === 2 ? stale.promise : fresh.promise;
		},
		play: async () => listener?.(),
		subscribe: (next) => {
			listener = next;
			return () => {};
		},
	};
	const dock = setup(backend);
	await dock.start();

	const command = dock.command("music");
	await flushRefresh();
	expect(dock.statuses.at(-1)).toContain("⏸");

	stale.resolve(state("paused"));
	await flushRefresh();
	expect(dock.statuses.at(-1)).toContain("⏸");

	fresh.resolve(state());
	await command;
	expect(dock.statuses.at(-1)).toContain("⏸");
});

test("polling works without events and shutdown releases all resources", async () => {
	let disposed = 0;
	const pending = deferred<PlayerState | null>();
	let calls = 0;
	const backend: MusicBackend = {
		id: "fake",
		label: "Fake",
		remoteControl: false,
		authenticated: () => true,
		player: () => (++calls === 1 ? Promise.resolve(state()) : pending.promise),
		play: async () => {},
		subscribe: () => () => {
			disposed++;
		},
	};
	const dock = setup(backend);
	await dock.start();
	const poll = dock.activeTimeouts()[0]!;
	poll.active = false;
	poll.callback();
	expect(calls).toBe(2);
	await dock.shutdown();
	await dock.shutdown();
	pending.resolve(state("paused"));
	await flushRefresh();
	expect(disposed).toBe(1);
	expect(dock.activeTimeouts()).toHaveLength(0);
	expect(dock.intervals.filter((timer) => timer.active)).toHaveLength(0);
	expect(dock.statuses.at(-1)).toBeUndefined();
});

test("reload disposes the previous subscription and poll before replacing them", async () => {
	let disposals = 0;
	const backend: MusicBackend = {
		id: "fake",
		label: "Fake",
		remoteControl: false,
		authenticated: () => true,
		player: async () => state(),
		play: async () => {},
		subscribe: () => () => {
			disposals++;
		},
	};
	const dock = setup(backend);
	await dock.start();
	const firstPoll = dock.activeTimeouts()[0]!;
	await dock.start();
	expect(disposals).toBe(1);
	expect(firstPoll.active).toBeFalse();
	expect(dock.activeTimeouts()).toHaveLength(1);
});

test("reload ignores an old pending sample and starts a new initial sample", async () => {
	const first = deferred<PlayerState | null>();
	const second = deferred<PlayerState | null>();
	let calls = 0;
	const backend: MusicBackend = {
		id: "fake",
		label: "Fake",
		remoteControl: false,
		authenticated: () => true,
		player: () => (++calls === 1 ? first.promise : second.promise),
		play: async () => {},
		subscribe: () => () => {},
	};
	const dock = setup(backend);
	void dock.start();
	const reloaded = dock.start();
	expect(calls).toBe(2);
	const statusCount = dock.statuses.length;
	first.resolve(state());
	await flushRefresh();
	expect(dock.statuses).toHaveLength(statusCount);
	second.resolve(state("paused"));
	await reloaded;
	expect(dock.activeTimeouts().map((timer) => timer.delay)).toEqual([5_000]);
});

test("reload isolates pending transport commands and their errors", async () => {
	let rejectOld!: (reason: Error) => void;
	let resolveNew!: () => void;
	let playCalls = 0;
	const oldPlay = new Promise<void>((_resolve, reject) => {
		rejectOld = reject;
	});
	const newPlay = new Promise<void>((resolve) => {
		resolveNew = resolve;
	});
	const backend: MusicBackend = {
		id: "fake",
		label: "Fake",
		remoteControl: false,
		authenticated: () => true,
		player: async () => state("paused"),
		play: () => (++playCalls === 1 ? oldPlay : newPlay),
	};
	const dock = setup(backend);
	await dock.start();
	const oldCommand = dock.command("music");
	await flushRefresh();
	await dock.start();
	const newCommand = dock.command("music");
	await flushRefresh();
	expect(playCalls).toBe(2);
	rejectOld(new Error("old command failed"));
	await oldCommand;
	expect(dock.notifications).toEqual([]);
	await dock.command("music");
	expect(playCalls).toBe(2);
	resolveNew();
	await newCommand;
});

test("poll-only backends retain the three, five, and eight second bounds", async () => {
	const samples = [state(), state("paused"), state("idle")];
	const backend: MusicBackend = {
		id: "fake",
		label: "Fake",
		remoteControl: false,
		authenticated: () => true,
		player: async () => samples.shift() ?? state("idle"),
		play: async () => {},
	};
	const dock = setup(backend);
	await dock.start();
	for (const expected of [5_000, 8_000]) {
		const poll = dock.activeTimeouts()[0]!;
		poll.active = false;
		poll.callback();
		await flushRefresh();
		expect(dock.activeTimeouts().map((timer) => timer.delay)).toEqual([
			expected,
		]);
	}
});

test("authoritative snapshots render synchronously and invalidate older samples", async () => {
	let listener: ((event?: MusicChangeEvent) => void) | undefined;
	const held = deferred<PlayerState | null>();
	let calls = 0;
	const backend: MusicBackend = {
		id: "fake",
		label: "Fake",
		remoteControl: false,
		authenticated: () => true,
		player: () => {
			calls++;
			return held.promise;
		},
		play: async () => {},
		subscribe: (next) => {
			listener = next;
			return () => {};
		},
	};
	const dock = setup(backend);
	const started = dock.start();
	const snapshot = {
		...state("paused"),
		track: { ...state("paused").track!, name: "Changed" },
	};
	listener?.({ type: "invalidation", reason: "stream-terminated" });
	listener?.({ type: "snapshot", state: snapshot });
	expect(calls).toBe(1);
	expect(dock.statuses.at(-1)).toContain("▶");
	expect(dock.statuses.at(-1)).toContain("Changed");
	held.resolve(state());
	await started;
	expect(calls).toBe(1);
	expect(dock.statuses.at(-1)).toContain("Changed");
});

test("stream termination uses the coalesced sampling lane and one recovery poll", async () => {
	let listener: ((event?: MusicChangeEvent) => void) | undefined;
	const recovery = deferred<PlayerState | null>();
	let calls = 0;
	const backend: MusicBackend = {
		id: "fake",
		label: "Fake",
		remoteControl: false,
		authenticated: () => true,
		player: () =>
			++calls === 1 ? Promise.resolve(state("paused")) : recovery.promise,
		play: async () => {},
		subscribe: (next) => {
			listener = next;
			return () => {};
		},
	};
	const dock = setup(backend);
	await dock.start();
	listener?.({ type: "invalidation", reason: "stream-terminated" });
	expect(calls).toBe(2);
	recovery.resolve(state("paused"));
	await flushRefresh();
	expect(dock.activeTimeouts().map((timer) => timer.delay)).toEqual([5_000]);
	const poll = dock.activeTimeouts()[0]!;
	poll.active = false;
	poll.callback();
	expect(calls).toBe(3);
});

test("shortcuts retain FIFO order and release commands before reconciliation", async () => {
	const heldSample = deferred<PlayerState | null>();
	const commands: string[] = [];
	const deferredCommands = [
		deferred<void>(),
		deferred<void>(),
		deferred<void>(),
		deferred<void>(),
	];
	let commandIndex = 0;
	const backend: MusicBackend = {
		id: "fake",
		label: "Fake",
		remoteControl: false,
		authenticated: () => true,
		player: () => heldSample.promise,
		play: () => {
			commands.push("play");
			return deferredCommands[commandIndex++]!.promise;
		},
		pause: () => {
			commands.push("pause");
			return deferredCommands[commandIndex++]!.promise;
		},
		next: () => {
			commands.push("next");
			return deferredCommands[commandIndex++]!.promise;
		},
		previous: () => {
			commands.push("previous");
			return deferredCommands[commandIndex++]!.promise;
		},
	};
	const dock = setup(backend, { controllableSleep: true });
	void dock.start();
	const accepted = [
		dock.shortcut(0),
		dock.shortcut(0),
		dock.shortcut(1),
		dock.shortcut(2),
	];
	await flushRefresh();
	expect(commands).toEqual(["play"]);
	deferredCommands[0]!.resolve();
	await accepted[0];
	await flushRefresh();
	expect(commands).toEqual(["play", "pause"]);
	expect(dock.sleeps.map((sleep) => sleep.delay)).toEqual([120]);
	deferredCommands[1]!.resolve();
	await accepted[1];
	await flushRefresh();
	expect(commands).toEqual(["play", "pause", "next"]);
	expect(dock.sleeps.map((sleep) => sleep.delay)).toEqual([120, 120]);
	deferredCommands[2]!.resolve();
	await accepted[2];
	await flushRefresh();
	expect(commands).toEqual(["play", "pause", "next", "previous"]);
	expect(dock.sleeps.map((sleep) => sleep.delay)).toEqual([120, 120, 150]);
	deferredCommands[3]!.resolve();
	await accepted[3];
	await Promise.all(accepted);
	expect(commands).toEqual(["play", "pause", "next", "previous"]);
	heldSample.resolve(state("paused"));
});

test("reload settles callers and suppresses every late old-session effect", async () => {
	const sample = deferred<PlayerState | null>();
	const replacementSample = deferred<PlayerState | null>();
	const activeCommand = deferred<void>();
	const listeners: Array<(event?: MusicChangeEvent) => void> = [];
	const commands: string[] = [];
	let playerCalls = 0;
	const backend: MusicBackend = {
		id: "fake",
		label: "Fake",
		remoteControl: false,
		authenticated: () => true,
		player: () =>
			++playerCalls === 2
				? sample.promise
				: playerCalls === 3
					? replacementSample.promise
					: Promise.resolve(state("paused")),
		play: async () => {},
		next: () => {
			commands.push("next");
			return activeCommand.promise;
		},
		previous: async () => {
			commands.push("previous");
		},
		subscribe: (listener) => {
			listeners.push(listener);
			return () => {};
		},
	};
	const dock = setup(backend, { controllableSleep: true });
	await dock.start();
	const oldPoll = dock.activeTimeouts()[0]!;
	const reconcile = dock.command("music");
	await reconcile;
	const oldInterval = dock.intervals.find((timer) => timer.active)!;
	const active = dock.command("music-next");
	const queued = [dock.command("music-prev"), dock.command("music")];
	listeners[0]?.({ type: "invalidation", reason: "stream-terminated" });
	await flushRefresh();
	expect(commands).toEqual(["next"]);
	expect(dock.sleeps).toHaveLength(1);

	const reloaded = dock.start()!;
	expect(playerCalls).toBe(3);
	await expectSettled(active);
	await Promise.all(queued);
	let reloadComplete = false;
	void reloaded.then(() => {
		reloadComplete = true;
	});
	await flushRefresh();
	expect(reloadComplete).toBeFalse();
	replacementSample.resolve(state("paused"));
	await reloaded;
	expect(commands).toEqual(["next"]);
	expect(oldPoll.active).toBeFalse();
	expect(oldInterval.active).toBeFalse();
	const statusCount = dock.statuses.length;
	const notificationCount = dock.notifications.length;
	listeners[0]?.({ type: "snapshot", state: state() });
	oldPoll.callback();
	oldInterval.callback();
	dock.sleeps[0]!.resolve();
	sample.resolve(state());
	activeCommand.reject(new Error("old failure"));
	await flushRefresh();
	expect(commands).toEqual(["next"]);
	expect(dock.statuses).toHaveLength(statusCount);
	expect(dock.notifications).toHaveLength(notificationCount);
});

test("shutdown settles callers, clears the event UI, and suppresses late effects", async () => {
	const sample = deferred<PlayerState | null>();
	const activeCommand = deferred<void>();
	const listeners: Array<(event?: MusicChangeEvent) => void> = [];
	const commands: string[] = [];
	let playerCalls = 0;
	const backend: MusicBackend = {
		id: "fake",
		label: "Fake",
		remoteControl: false,
		authenticated: () => true,
		player: () =>
			++playerCalls === 2 ? sample.promise : Promise.resolve(state("paused")),
		play: async () => {},
		next: () => {
			commands.push("next");
			return activeCommand.promise;
		},
		previous: async () => {
			commands.push("previous");
		},
		subscribe: (listener) => {
			listeners.push(listener);
			return () => {};
		},
	};
	const dock = setup(backend, { controllableSleep: true });
	await dock.start();
	const oldPoll = dock.activeTimeouts()[0]!;
	await dock.command("music");
	const oldInterval = dock.intervals.find((timer) => timer.active)!;
	const active = dock.command("music-next");
	const queued = [dock.command("music-prev"), dock.command("music")];
	listeners[0]?.({ type: "invalidation", reason: "stream-terminated" });
	await flushRefresh();
	const shutdownStatuses: Array<string | undefined> = [];
	const shutdownContext = {
		mode: "tui",
		hasUI: true,
		ui: {
			setStatus: (_key: string, value: string | undefined) =>
				shutdownStatuses.push(value),
			theme: { fg: (_color: string, value: string) => value },
			notify: (_message: string) => {},
		},
	};
	await dock.shutdown(shutdownContext);
	await expectSettled(active);
	await Promise.all(queued);
	expect(commands).toEqual(["next"]);
	expect(shutdownStatuses).toEqual([undefined]);
	expect(oldPoll.active).toBeFalse();
	expect(oldInterval.active).toBeFalse();
	const statusCount = dock.statuses.length;
	listeners[0]?.({ type: "snapshot", state: state() });
	oldPoll.callback();
	oldInterval.callback();
	dock.sleeps[0]!.reject(new Error("late delay"));
	sample.reject(new Error("late sample"));
	activeCommand.resolve();
	await flushRefresh();
	expect(commands).toEqual(["next"]);
	expect(dock.statuses).toHaveLength(statusCount);
	expect(dock.notifications).toEqual([]);
});

test("a live rejected command notifies once, resolves its caller, and continues the queue", async () => {
	const rejectedPlay = deferred<void>();
	const completedPause = deferred<void>();
	const commands: string[] = [];
	const backend: MusicBackend = {
		id: "fake",
		label: "Fake",
		remoteControl: false,
		authenticated: () => true,
		player: async () => state("paused"),
		play: () => {
			commands.push("play");
			return rejectedPlay.promise;
		},
		pause: () => {
			commands.push("pause");
			return completedPause.promise;
		},
	};
	const dock = setup(backend);
	await dock.start();

	const rejectedCaller = dock.command("music");
	const nextCaller = dock.command("music");
	await flushRefresh();

	expect(commands).toEqual(["play"]);
	rejectedPlay.reject(new Error("play failed"));
	await rejectedCaller;
	await flushRefresh();

	expect(dock.notifications).toEqual(["play failed"]);
	expect(commands).toEqual(["play", "pause"]);
	completedPause.resolve();
	await nextCaller;
});
