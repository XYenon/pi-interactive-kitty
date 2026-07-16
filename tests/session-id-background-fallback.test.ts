import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeadlessCompletionInfo } from "../headless-monitor.js";

/**
 * P-1: after the first completed sessionId poll unregisters active, further
 * sessionId / incremental / drain queries must succeed via the background entry.
 */
async function setupHarness() {
	const unregisterActiveSpy = vi.fn();
	const registerActive = vi.fn();
	const scheduleCleanup = vi.fn();
	const restartAutoCleanup = vi.fn();
	const monitors: Array<{ options: any; complete: (info: HeadlessCompletionInfo) => void }> = [];
	const dataListeners = new Set<(data: string) => void>();
	const bgEntries = new Map<string, any>();
	const queryStates = new Map<string, { lastQueryTime: number; incrementalReadPosition: number; incrementalCharOffset: number }>();
	let activeById = new Map<string, any>();
	let sessionExited = false;
	let toolDef: any;

	const terminalSession = {
		ready: Promise.resolve(),
		get exited() {
			return sessionExited;
		},
		exitCode: null as number | null,
		signal: undefined as number | undefined,
		pid: 4242,
		cols: 120,
		rows: 40,
		setEventHandlers() {},
		addDataListener(cb: (data: string) => void) {
			dataListeners.add(cb);
			return () => dataListeners.delete(cb);
		},
		addExitListener() {
			return () => {};
		},
		write() {},
		sendKeys() {},
		paste() {},
		focus() {},
		kill() {
			sessionExited = true;
		},
		getTailLines: vi.fn(async () => ({
			lines: ["LINE-001", "LINE-002", "LINE-003", "LINE-004", "LINE-005"],
			totalLinesInBuffer: 5,
			truncatedByChars: false,
		})),
		getRawStream: vi.fn(() => "stream-delta"),
		getLogSlice: vi.fn(async ({ offset = 0, limit = 50 }: { offset?: number; limit?: number } = {}) => {
			const lines = ["LINE-001", "LINE-002", "LINE-003", "LINE-004", "LINE-005"];
			const slice = lines.slice(offset, offset + limit).join("\n");
			return { slice, totalLines: lines.length, totalChars: slice.length, sliceLineCount: slice ? slice.split("\n").length : 0 };
		}),
		dispose() {},
	};

	vi.resetModules();
	vi.doMock("@mariozechner/pi-coding-agent", () => ({
		getAgentDir: () => "/tmp/pi-agent",
	}));
	vi.doMock("@mariozechner/pi-tui", () => ({
		matchesKey: () => false,
		truncateToWidth: (value: string) => value,
		visibleWidth: (value: string) => value.length,
	}));
	vi.doMock("../config.js", async () => {
		const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
		return {
			...actual,
			loadConfig: vi.fn(() => ({
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
					version: [0, 47, 4],
					responseTimeoutMs: 5000,
					pollIntervalMs: 500,
					osWindowTitle: "Pi Interactive Kitty",
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
			})),
		};
	});
	vi.doMock("../kitty-session.js", () => ({
		KittyTerminalSession: class {
			ready = Promise.resolve();
			exited = false;
			exitCode = null;
			signal = undefined;
			constructor() {
				return terminalSession as any;
			}
		},
	}));
	vi.doMock("../headless-monitor.js", () => ({
		HeadlessDispatchMonitor: class {
			disposed = false;
			options: any;
			private completeCb: ((info: HeadlessCompletionInfo) => void) | null = null;
			private result: HeadlessCompletionInfo | undefined;
			private localComplete: Array<() => void> = [];
			constructor(_session: any, _config: any, options: any, onComplete: (info: HeadlessCompletionInfo) => void) {
				this.options = options;
				this.completeCb = onComplete;
				monitors.push(this as any);
			}
			complete(info: HeadlessCompletionInfo) {
				this.result = info;
				sessionExited = true;
				this.disposed = true;
				for (const cb of this.localComplete) cb();
				this.completeCb?.(info);
			}
			getResult() {
				return this.result;
			}
			cancel() {
				this.complete({ exitCode: null, cancelled: true });
			}
			setQuietThreshold() {}
			registerCompleteCallback(cb: () => void) {
				if (this.result) {
					cb();
					return;
				}
				this.localComplete.push(cb);
			}
			dispose() {
				this.disposed = true;
			}
		},
	}));
	vi.doMock("../handoff-utils.js", () => ({
		captureCompletionOutput: vi.fn(async () => ({ lines: ["ok"], totalLines: 1, truncated: false })),
		maybeBuildHandoffPreview: vi.fn(async () => undefined),
		maybeWriteHandoffSnapshot: vi.fn(async () => undefined),
	}));
	vi.doMock("../session-manager.js", () => ({
		sessionManager: {
			getActive: vi.fn((id: string) => activeById.get(id)),
			unregisterActive: vi.fn((id: string) => {
				unregisterActiveSpy(id);
				activeById.delete(id);
			}),
			list: vi.fn(() => Array.from(bgEntries.values())),
			add: vi.fn((_cmd: string, session: any, _name: any, reason: any, options: any) => {
				const id = options?.id ?? "sharp-atlas";
				bgEntries.set(id, {
					id,
					name: id,
					command: _cmd,
					reason,
					session,
					startedAt: options?.startedAt ?? new Date(),
				});
				return id;
			}),
			take: vi.fn(() => undefined),
			get: vi.fn((id: string) => bgEntries.get(id)),
			peekBackground: vi.fn((id: string) => bgEntries.get(id)),
			hasBackground: vi.fn((id: string) => bgEntries.has(id)),
			setBackgroundResult: vi.fn((id: string, result: any) => {
				const entry = bgEntries.get(id);
				if (entry) entry.lastResult = result;
			}),
			getBackgroundResult: vi.fn((id: string) => bgEntries.get(id)?.lastResult),
			getQueryState: vi.fn((id: string) => {
				let state = queryStates.get(id);
				if (!state) {
					state = { lastQueryTime: 0, incrementalReadPosition: 0, incrementalCharOffset: 0 };
					queryStates.set(id, state);
				}
				return state;
			}),
			restore: vi.fn(),
			remove: vi.fn((id: string) => bgEntries.delete(id)),
			scheduleCleanup,
			restartAutoCleanup,
			registerActive: vi.fn((session: any) => {
				registerActive(session);
				activeById.set(session.id, session);
			}),
			killAll: vi.fn(),
			onChange: vi.fn(() => () => {}),
			setActiveUpdateInterval: vi.fn(() => false),
			setActiveQuietThreshold: vi.fn(() => false),
			writeToActive: vi.fn(() => false),
		},
		generateSessionId: vi.fn(() => "sharp-atlas"),
	}));
	vi.doMock("../runtime-coordinator.js", () => ({
		InteractiveShellCoordinator: class {
			markAgentHandledCompletion = vi.fn();
			consumeAgentHandledCompletion = vi.fn(() => false);
			getMonitor = vi.fn(() => undefined);
			replaceBackgroundWidgetCleanup = vi.fn();
			clearBackgroundWidget = vi.fn();
			disposeAllMonitors = vi.fn();
			disposeMonitor = vi.fn();
			deleteMonitor = vi.fn();
			setMonitor = vi.fn();
			getMonitorSessionState = vi.fn(() => undefined);
			clearMonitorEvents = vi.fn();
			registerMonitorSession = vi.fn();
		},
	}));

	const extensionModule = await import("../index.js");
	extensionModule.default({
		registerShortcut: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn((definition: any) => {
			toolDef = definition;
		}),
		on: vi.fn(),
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
	} as any);

	const ctx = {
		cwd: "/tmp",
		ui: {},
		sessionManager: { getSessionFile: () => undefined },
		hasUI: true,
	};

	return {
		toolDef,
		registerActive,
		unregisterActive: unregisterActiveSpy,
		restartAutoCleanup,
		completeLatestMonitor: (info: HeadlessCompletionInfo) => {
			const monitor = monitors.at(-1);
			if (!monitor) throw new Error("no monitor");
			(monitor as any).complete(info);
		},
		ctx,
		terminalSession,
		flush: async () => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		},
	};
}

describe("sessionId background fallback (P-1)", () => {
	afterEach(() => {
		vi.doUnmock("@mariozechner/pi-coding-agent");
		vi.doUnmock("@mariozechner/pi-tui");
		vi.doUnmock("../config.js");
		vi.doUnmock("../kitty-session.js");
		vi.doUnmock("../headless-monitor.js");
		vi.doUnmock("../session-manager.js");
		vi.doUnmock("../runtime-coordinator.js");
		vi.doUnmock("../handoff-utils.js");
		vi.resetModules();
	});

	it("allows repeated sessionId / incremental / drain queries after the first result poll unregisters active", async () => {
		const harness = await setupHarness();
		const start = await harness.toolDef.execute(
			"call-start",
			{ command: "echo fresh-test", mode: "hands-free" },
			undefined,
			undefined,
			harness.ctx,
		);
		expect(start.isError).toBeFalsy();
		expect(start.details.sessionId).toBe("sharp-atlas");
		expect(harness.registerActive).toHaveBeenCalled();

		harness.completeLatestMonitor({
			exitCode: 0,
			completionOutput: { lines: ["LINE-001", "LINE-002", "LINE-003", "LINE-004", "LINE-005"], totalLines: 5, truncated: false },
		});
		await harness.flush();

		// First poll while still active — consumes result and unregisters active.
		const first = await harness.toolDef.execute("call-1", { sessionId: "sharp-atlas" }, undefined, undefined, harness.ctx);
		expect(first.isError).toBeFalsy();
		expect(first.content[0]?.text).toMatch(/exited|LINE-/);
		expect(harness.unregisterActive).toHaveBeenCalled();

		// Second query must not 404 — falls back to background + shared query state.
		const second = await harness.toolDef.execute(
			"call-2",
			{ sessionId: "sharp-atlas", incremental: true, outputLines: 2 },
			undefined,
			undefined,
			harness.ctx,
		);
		expect(second.isError).toBeFalsy();
		expect(second.content[0]?.text).not.toMatch(/not found/i);
		expect(second.details.output).toContain("LINE-001");
		expect(second.details.hasMore).toBe(true);
		// lastResult should still expose exit metadata after active was dropped.
		expect(second.details.exitCode).toBe(0);
		expect(second.details.cancelled).toBe(false);

		const third = await harness.toolDef.execute(
			"call-3",
			{ sessionId: "sharp-atlas", incremental: true, outputLines: 2 },
			undefined,
			undefined,
			harness.ctx,
		);
		expect(third.isError).toBeFalsy();
		expect(third.details.output).toContain("LINE-003");
		expect(third.details.output).not.toContain("LINE-001");

		const drain = await harness.toolDef.execute("call-4", { sessionId: "sharp-atlas", drain: true }, undefined, undefined, harness.ctx);
		expect(drain.isError).toBeFalsy();
		expect(drain.content[0]?.text).not.toMatch(/not found/i);
		expect(harness.restartAutoCleanup).toHaveBeenCalled();
	});
});
