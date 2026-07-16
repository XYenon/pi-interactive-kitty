import { beforeEach, describe, expect, it, vi } from "vitest";
import { HeadlessDispatchMonitor } from "../headless-monitor.js";
import type { InteractiveShellConfig } from "../config.js";

const config: InteractiveShellConfig = {
	focusShortcut: "alt+shift+f",
	spawn: {
		defaultAgent: "pi",
		shortcut: "alt+shift+p",
		commands: { pi: "pi", codex: "codex", claude: "claude", cursor: "agent" },
		defaultArgs: { pi: [], codex: [], claude: [], cursor: [] },
		worktree: false,
		worktreeBaseDir: undefined,
	},
	kitty: {
		listenOn: undefined,
		remoteControlPassword: undefined,
		publicKey: undefined,
		version: [0, 47, 4],
		responseTimeoutMs: 10000,
		connectTimeoutMs: 5000,
		pollIntervalMs: 100,
		killGraceMs: 5000,
		osWindowTitle: "pi-interactive-kitty",
		tabTitlePrefix: "pi-shell",
		focusNewSessions: true,
	},
	scrollbackLines: 5000,
	ansiReemit: true,
	handoffPreviewEnabled: true,
	handoffPreviewLines: 30,
	handoffPreviewMaxChars: 2000,
	handoffSnapshotEnabled: false,
	handoffSnapshotLines: 200,
	handoffSnapshotMaxChars: 12000,
	completionNotifyLines: 50,
	completionNotifyMaxChars: 5000,
	handsFreeUpdateMode: "on-quiet",
	handsFreeUpdateInterval: 60000,
	handsFreeQuietThreshold: 8000,
	autoExitGracePeriod: 15000,
	handsFreeUpdateMaxChars: 1500,
	handsFreeMaxTotalChars: 100000,
	minQueryIntervalSeconds: 60,
};

function createSession() {
	let onData: ((data: string) => void) | null = null;
	let onExit: ((exitCode: number | null, signal?: number) => void) | null = null;
	let rawOutput = "";
	const session = {
		exited: false,
		exitCode: null as number | null,
		signal: undefined as number | undefined,
		// Mirror KittyTerminalSession.kill(): exit is observed asynchronously after signal/grace.
		kill: vi.fn(() => {
			queueMicrotask(() => {
				if (!session.exited) {
					session.emitExit(null);
				}
			});
		}),
		getTailLines: vi.fn(async () => ({ lines: ["final"], totalLinesInBuffer: 1, truncatedByChars: false })),
		getRawStream: vi.fn(() => rawOutput),
		getLogSlice: vi.fn(async (opts?: { offset?: number; stripAnsi?: boolean }) => ({
			slice: rawOutput,
			totalLines: rawOutput.split("\n").length,
			totalChars: rawOutput.length,
			sliceLineCount: rawOutput.split("\n").length,
		})),
		addDataListener(fn: (data: string) => void) {
			onData = fn;
			return () => {
				onData = null;
			};
		},
		addExitListener(fn: (exitCode: number | null, signal?: number) => void) {
			onExit = fn;
			return () => {
				onExit = null;
			};
		},
		emitData(data: string) {
			rawOutput += data;
			onData?.(data);
		},
		emitExit(exitCode: number | null, signal?: number) {
			this.exited = true;
			this.exitCode = exitCode;
			this.signal = signal;
			onExit?.(exitCode, signal);
		},
	};
	return session as any;
}

describe("HeadlessDispatchMonitor", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("does not reset quiet timer for ANSI-only data", async () => {
		const session = createSession();
		const onComplete = vi.fn();
		new HeadlessDispatchMonitor(
			session,
			config,
			{
				autoExitOnQuiet: true,
				quietThreshold: 1000,
				gracePeriod: 0,
				startedAt: 0,
			},
			onComplete,
		);

		session.emitData("\u001b[2K\u001b[1G");
		await vi.advanceTimersByTimeAsync(1000);
		await Promise.resolve();
		await Promise.resolve();
		expect(session.kill).toHaveBeenCalledTimes(1);
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it("respects startup grace period and preserves explicit startedAt", () => {
		vi.setSystemTime(new Date("2026-03-12T20:00:00.000Z"));
		const explicitStartTime = Date.now() - 4000;
		const session = createSession();
		const monitor = new HeadlessDispatchMonitor(
			session,
			config,
			{
				autoExitOnQuiet: true,
				quietThreshold: 1000,
				gracePeriod: 5000,
				startedAt: explicitStartTime,
			},
			vi.fn(),
		);

		vi.advanceTimersByTime(999);
		expect(session.kill).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(session.kill).toHaveBeenCalledTimes(1);
		expect(monitor.startTime).toBe(explicitStartTime);
	});

	it("captures completion output on natural exit", async () => {
		const session = createSession();
		const onComplete = vi.fn();
		const monitor = new HeadlessDispatchMonitor(
			session,
			config,
			{
				autoExitOnQuiet: false,
				quietThreshold: 1000,
			},
			onComplete,
		);

		session.emitExit(0);
		await Promise.resolve();
		await Promise.resolve();
		expect(onComplete).toHaveBeenCalledWith({
			exitCode: 0,
			signal: undefined,
			timedOut: undefined,
			cancelled: undefined,
			completionOutput: {
				lines: ["final"],
				totalLines: 1,
				truncated: false,
			},
		});
		expect(monitor.getResult()?.completionOutput?.lines).toEqual(["final"]);
	});

	it("emits stream monitor events from ANSI-stripped line output", () => {
		const session = createSession();
		const onMonitorEvent = vi.fn();
		new HeadlessDispatchMonitor(
			session,
			config,
			{
				autoExitOnQuiet: false,
				quietThreshold: 1000,
				monitor: {
					strategy: "stream",
					triggers: [
						{
							id: "error",
							match: (input) => /ERROR:\s+.+/.exec(input)?.[0],
						},
					],
					pollIntervalMs: 5000,
					dedupeExactLine: true,
				},
				onMonitorEvent,
			},
			vi.fn(),
		);

		session.emitData("\u001b[31mERROR:\u001b[0m failed to compile\n");
		expect(onMonitorEvent).toHaveBeenCalledWith({
			strategy: "stream",
			triggerId: "error",
			eventType: "error",
			matchedText: "ERROR: failed to compile",
			lineOrDiff: "ERROR: failed to compile",
			stream: "terminal",
		});
	});

	it("emits file-watch monitor events from line output", () => {
		const session = createSession();
		const onMonitorEvent = vi.fn();
		new HeadlessDispatchMonitor(
			session,
			config,
			{
				autoExitOnQuiet: false,
				quietThreshold: 1000,
				monitor: {
					strategy: "file-watch",
					triggers: [
						{
							id: "pdf",
							match: (input) => (/\.pdf$/i.test(input) ? input : undefined),
						},
					],
					pollIntervalMs: 5000,
					dedupeExactLine: true,
				},
				onMonitorEvent,
			},
			vi.fn(),
		);

		session.emitData("RENAME invoices/acme-0042.pdf\n");
		expect(onMonitorEvent).toHaveBeenCalledWith({
			strategy: "file-watch",
			triggerId: "pdf",
			eventType: "pdf",
			matchedText: "RENAME invoices/acme-0042.pdf",
			lineOrDiff: "RENAME invoices/acme-0042.pdf",
			stream: "terminal",
		});
	});

	it("dedupes exact matching lines per trigger within one stream monitor session", () => {
		const session = createSession();
		const onMonitorEvent = vi.fn();
		new HeadlessDispatchMonitor(
			session,
			config,
			{
				autoExitOnQuiet: false,
				quietThreshold: 1000,
				monitor: {
					strategy: "stream",
					triggers: [
						{
							id: "tests",
							match: (input) => /Test Files/.exec(input)?.[0],
						},
					],
					pollIntervalMs: 5000,
					dedupeExactLine: true,
				},
				onMonitorEvent,
			},
			vi.fn(),
		);

		session.emitData("Test Files  1 passed (1)\n");
		session.emitData("Test Files  1 passed (1)\n");
		expect(onMonitorEvent).toHaveBeenCalledTimes(1);
	});

	it("emits poll-diff events when normalized output changes", async () => {
		const session = createSession();
		const onMonitorEvent = vi.fn();
		new HeadlessDispatchMonitor(
			session,
			config,
			{
				autoExitOnQuiet: false,
				quietThreshold: 1000,
				monitor: {
					strategy: "poll-diff",
					triggers: [
						{
							id: "changed",
							match: (input) => (input.length > 0 ? "changed" : undefined),
						},
					],
					pollIntervalMs: 500,
					dedupeExactLine: true,
				},
				onMonitorEvent,
			},
			vi.fn(),
		);

		await vi.advanceTimersByTimeAsync(500); // establish baseline
		session.emitData("status=green\n");
		await vi.advanceTimersByTimeAsync(500); // changed snapshot

		expect(onMonitorEvent).toHaveBeenCalledTimes(1);
		expect(onMonitorEvent.mock.calls[0]?.[0]).toMatchObject({
			strategy: "poll-diff",
			triggerId: "changed",
			eventType: "changed",
			matchedText: "changed",
			stream: "terminal",
		});
	});

	it("awaits poll-diff flush before completion so final screen can match", async () => {
		const session = createSession();
		const order: string[] = [];
		let getLogCalls = 0;
		const onMonitorEvent = vi.fn(() => {
			order.push("event");
		});
		const onComplete = vi.fn(() => {
			order.push("complete");
		});
		// First call (completion flush) yields once so dispose would race if not awaited.
		session.getLogSlice = vi.fn(async () => {
			getLogCalls += 1;
			if (getLogCalls === 1) {
				await Promise.resolve();
				await Promise.resolve();
			}
			return {
				slice: "build DONE\n",
				totalLines: 1,
				totalChars: 11,
				sliceLineCount: 1,
			};
		});

		new HeadlessDispatchMonitor(
			session,
			config,
			{
				autoExitOnQuiet: false,
				quietThreshold: 1000,
				monitor: {
					strategy: "poll-diff",
					triggers: [
						{
							id: "done",
							match: (input) => (/DONE/.test(input) ? "DONE" : undefined),
						},
					],
					pollIntervalMs: 60_000,
					dedupeExactLine: true,
				},
				onMonitorEvent,
			},
			onComplete,
		);

		// Exit before any interval tick; final line is only visible via getLogSlice.
		session.emitExit(0);
		// Immediately after exit, completion must not have finished (flush still pending).
		expect(onComplete).not.toHaveBeenCalled();

		await vi.waitFor(() => {
			expect(onMonitorEvent).toHaveBeenCalled();
			expect(onComplete).toHaveBeenCalled();
		});

		expect(onMonitorEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				strategy: "poll-diff",
				triggerId: "done",
				matchedText: "DONE",
			}),
		);
		// Event must land before completion callback (deleteMonitor would drop it).
		expect(order.indexOf("event")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("event")).toBeLessThan(order.indexOf("complete"));
	});

	it("dispose() runs local complete callbacks so hands-free timers stop when the monitor is dismissed", () => {
		const session = createSession();
		const onComplete = vi.fn();
		const localComplete = vi.fn();
		const monitor = new HeadlessDispatchMonitor(
			session,
			config,
			{
				autoExitOnQuiet: false,
				quietThreshold: 1000,
			},
			onComplete,
		);
		monitor.registerCompleteCallback(localComplete);

		monitor.dispose();
		// dispose runs local cleanup (progress timers etc.) but is silent — onComplete is not invoked.
		expect(localComplete).toHaveBeenCalledTimes(1);
		expect(onComplete).not.toHaveBeenCalled();
		expect(monitor.disposed).toBe(true);
	});

	it("cancel waits for session exit before capturing completion output", async () => {
		const session = createSession();
		let capturedWhileExited = false;
		session.kill = vi.fn(() => {
			// Delayed exit: cleanup output becomes available only after kill drains.
			setTimeout(() => {
				session.emitData("cleanup done\n");
				session.getTailLines = vi.fn(async () => {
					capturedWhileExited = session.exited;
					return { lines: ["cleanup done"], totalLinesInBuffer: 1, truncatedByChars: false };
				});
				session.emitExit(143, 15);
			}, 50);
		});
		const onComplete = vi.fn();
		const monitor = new HeadlessDispatchMonitor(
			session,
			config,
			{
				autoExitOnQuiet: false,
				quietThreshold: 1000,
			},
			onComplete,
		);

		monitor.cancel();
		expect(session.kill).toHaveBeenCalledTimes(1);
		expect(onComplete).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(50);
		await Promise.resolve();
		await Promise.resolve();

		expect(capturedWhileExited).toBe(true);
		expect(onComplete).toHaveBeenCalledWith({
			exitCode: 143,
			signal: 15,
			timedOut: undefined,
			cancelled: true,
			completionOutput: {
				lines: ["cleanup done"],
				totalLines: 1,
				truncated: false,
			},
		});
		expect(monitor.getResult()?.cancelled).toBe(true);
	});

	it("cancel skips kill and uses current exit status when session already exited", async () => {
		const session = createSession();
		const onComplete = vi.fn();
		const monitor = new HeadlessDispatchMonitor(
			session,
			config,
			{
				autoExitOnQuiet: false,
				quietThreshold: 1000,
			},
			onComplete,
		);

		// Session exited without firing the exit listener (e.g. observed via polling/status).
		session.exited = true;
		session.exitCode = 7;
		monitor.cancel();

		await Promise.resolve();
		await Promise.resolve();

		expect(session.kill).not.toHaveBeenCalled();
		expect(onComplete).toHaveBeenCalledWith({
			exitCode: 7,
			signal: undefined,
			timedOut: undefined,
			cancelled: true,
			completionOutput: {
				lines: ["final"],
				totalLines: 1,
				truncated: false,
			},
		});
	});
});
