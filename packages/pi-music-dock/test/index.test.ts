import { expect, test } from "bun:test";
import type { MusicBackend, PlayerState } from "@naxodev/music-core";
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
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function flushRefresh(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function setup(backend: MusicBackend) {
	let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
	let shutdown: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
	const timeouts: Timer[] = [];
	const intervals: Timer[] = [];
	const statuses: Array<string | undefined> = [];
	const notifications: string[] = [];
	const commands: Record<
		string,
		{ handler: (args: string, ctx: unknown) => Promise<void> }
	> = {};
	const ui = {
		setStatus: (_key: string, value: string | undefined) =>
			statuses.push(value),
		theme: { fg: (_color: string, value: string) => value },
		notify: (message: string) => notifications.push(message),
	};
	const api = {
		registerShortcut: () => {},
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
		sleep: async () => {},
	});
	const ctx = { mode: "tui", hasUI: true, ui };
	return {
		start: () => start?.({}, ctx),
		shutdown: () => shutdown?.({}, ctx),
		timeouts,
		intervals,
		statuses,
		notifications,
		command: (name: string) => commands[name]!.handler("", ctx),
		activeTimeouts: () => timeouts.filter((timer) => timer.active),
	};
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
	await dock.start();
	const newCommand = dock.command("music");
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
