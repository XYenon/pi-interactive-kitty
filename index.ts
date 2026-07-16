import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { formatDuration, formatDurationMs } from "./types.js";
import type {
	HandsFreeUpdate,
	InteractiveShellOptions,
	InteractiveShellResult,
	MonitorConfig,
	MonitorEventPayload,
	MonitorFileWatchConfig,
	MonitorStrategy,
	MonitorTerminalReason,
	MonitorThresholdOperator,
	MonitorTriggerConfig,
} from "./types.js";
import { sessionManager, generateSessionId, releaseSessionId } from "./session-manager.js";
import type { ActiveSession, ActiveSessionResult, BackgroundSession } from "./session-manager.js";
import { loadConfig } from "./config.js";
import type { InteractiveShellConfig } from "./config.js";
import { parseSpawnArgs, resolveSpawn, type SpawnRequest } from "./spawn.js";
import { translateInput } from "./key-encoding.js";
import { KittyTerminalSession } from "./kitty-session.js";
import type { TerminalSession } from "./terminal-session.js";
import { TOOL_NAME, TOOL_LABEL, TOOL_DESCRIPTION, toolParameters, type ToolParams } from "./tool-schema.js";
import { HeadlessDispatchMonitor } from "./headless-monitor.js";
import type { HeadlessCompletionInfo, MonitorMatchInfo, MonitorRuntimeConfig, MonitorTriggerMatcher } from "./headless-monitor.js";
import { setupBackgroundWidget } from "./background-widget.js";
import {
	buildDispatchNotification,
	buildHandsFreeUpdateMessage,
	buildMonitorEventNotification,
	buildMonitorLifecycleNotification,
	buildResultNotification,
	summarizeInteractiveResult,
} from "./notification-utils.js";
import { getSessionOutput } from "./session-query.js";
import { InteractiveShellCoordinator } from "./runtime-coordinator.js";
import { captureCompletionOutput, maybeBuildHandoffPreview, maybeWriteHandoffSnapshot } from "./handoff-utils.js";
import { spawn as spawnChildProcess } from "node:child_process";

const coordinator = new InteractiveShellCoordinator();

function scheduleMonitorHistoryCleanup(sessionId: string, delayMs = 5 * 60 * 1000): void {
	const attempt = () => {
		const stillInUse =
			coordinator.getMonitor(sessionId) !== undefined ||
			sessionManager.getActive(sessionId) !== undefined ||
			sessionManager.list().some((session) => session.id === sessionId);
		if (stillInUse) {
			setTimeout(attempt, 30_000);
			return;
		}
		coordinator.clearMonitorEvents(sessionId);
	};
	setTimeout(attempt, delayMs);
}

type HandoffParamOverrides = Pick<
	InteractiveShellOptions,
	| "handoffPreviewEnabled"
	| "handoffPreviewLines"
	| "handoffPreviewMaxChars"
	| "handoffSnapshotEnabled"
	| "handoffSnapshotLines"
	| "handoffSnapshotMaxChars"
>;

function handoffOverridesFromParams(
	handoffPreview?: ToolParams["handoffPreview"],
	handoffSnapshot?: ToolParams["handoffSnapshot"],
): HandoffParamOverrides {
	return {
		handoffPreviewEnabled: handoffPreview?.enabled,
		handoffPreviewLines: handoffPreview?.lines,
		handoffPreviewMaxChars: handoffPreview?.maxChars,
		handoffSnapshotEnabled: handoffSnapshot?.enabled,
		handoffSnapshotLines: handoffSnapshot?.lines,
		handoffSnapshotMaxChars: handoffSnapshot?.maxChars,
	};
}

function handoffWhenFromCompletion(info: { timedOut?: boolean; cancelled?: boolean }): "exit" | "kill" | "timeout" {
	if (info.timedOut) return "timeout";
	if (info.cancelled) return "kill";
	return "exit";
}

/** Shared notes for session output blocks in tool responses. */
function outputDisplayNotes(
	truncated: boolean,
	totalBytes: number,
	hasMore?: boolean,
): {
	truncatedNote: string;
	hasMoreNote: string;
} {
	return {
		truncatedNote: truncated ? ` (${totalBytes} bytes total, truncated)` : "",
		hasMoreNote: hasMore === true ? " (more available)" : "",
	};
}

function describeInputPayload(input: string | { text?: string; keys?: string[]; paste?: string; hex?: string[] } | undefined): string {
	if (input === undefined) return "";
	if (typeof input === "string") {
		if (input.length === 0) return "(empty)";
		if (input.length > 50) return `${input.slice(0, 50)}...`;
		return input;
	}
	const parts = [
		input.text ?? "",
		input.keys ? `keys:[${input.keys.join(",")}]` : "",
		input.hex ? `hex:[${input.hex.length} bytes]` : "",
		input.paste ? `paste:[${input.paste.length} chars]` : "",
	].filter(Boolean);
	return parts.join(" + ") || "(empty)";
}

async function buildHandoffArtifacts(
	session: TerminalSession,
	when: "exit" | "detach" | "kill" | "timeout",
	config: InteractiveShellConfig,
	context: { command: string; cwd?: string },
	overrides?: HandoffParamOverrides,
): Promise<Pick<ActiveSessionResult, "handoffPreview" | "handoff">> {
	return {
		handoffPreview: await maybeBuildHandoffPreview(session, when, config, overrides),
		handoff: await maybeWriteHandoffSnapshot(session, when, config, context, overrides),
	};
}

type RegisteredHandoffContext = {
	session: TerminalSession;
	config: InteractiveShellConfig;
	context: { command: string; cwd?: string };
	overrides: HandoffParamOverrides;
};

const handoffContexts = new Map<string, RegisteredHandoffContext>();

function registerHandoffContext(
	id: string,
	session: TerminalSession,
	config: InteractiveShellConfig,
	context: { command: string; cwd?: string },
	overrides: HandoffParamOverrides,
): void {
	handoffContexts.set(id, { session, config, context, overrides });
}

async function buildRegisteredHandoffArtifacts(
	id: string,
	when: "exit" | "detach" | "kill" | "timeout",
): Promise<Pick<ActiveSessionResult, "handoffPreview" | "handoff"> | undefined> {
	const registered = handoffContexts.get(id);
	if (!registered) return undefined;
	return buildHandoffArtifacts(registered.session, when, registered.config, registered.context, registered.overrides);
}

function clearHandoffContext(id: string): void {
	handoffContexts.delete(id);
}

/** Unified 5-minute expiry for hands-free: drop active handle + handoff context + bg session. */
function scheduleHandsFreeExpiry(sessionId: string, delayMs = 5 * 60 * 1000): void {
	setTimeout(() => {
		if (sessionManager.getActive(sessionId)?.getResult()) {
			sessionManager.unregisterActive(sessionId, false);
		}
		clearHandoffContext(sessionId);
	}, delayMs);
	sessionManager.scheduleCleanup(sessionId, delayMs);
}

function completedSessionQueryDetails(
	sessionId: string,
	status: string,
	runtime: number,
	output: {
		output: string;
		truncated: boolean;
		totalBytes: number;
		totalLines?: number;
		hasMore?: boolean;
	},
	result: ActiveSessionResult,
): Record<string, unknown> {
	return {
		sessionId,
		status,
		runtime,
		output: output.output,
		outputTruncated: output.truncated,
		outputTotalBytes: output.totalBytes,
		outputTotalLines: output.totalLines,
		hasMore: output.hasMore,
		exitCode: result.exitCode,
		signal: result.signal,
		backgroundId: result.backgroundId,
		backgrounded: result.backgrounded,
		timedOut: result.timedOut,
		cancelled: result.cancelled,
		handoffPreview: result.handoffPreview,
		handoff: result.handoff,
	};
}

function buildCompletedSessionResponse(
	sessionId: string,
	status: string,
	runtime: number,
	outputResult: { output: string; truncated: boolean; totalBytes: number; totalLines?: number; hasMore?: boolean },
	result: ActiveSessionResult,
): {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
} {
	const { truncatedNote, hasMoreNote } = outputDisplayNotes(outputResult.truncated, outputResult.totalBytes, outputResult.hasMore);
	return {
		content: [
			{
				type: "text",
				text: `Session ${sessionId} ${status} after ${formatDurationMs(runtime)}${outputResult.output ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${outputResult.output}` : ""}`,
			},
		],
		details: completedSessionQueryDetails(sessionId, status, runtime, outputResult, result),
	};
}

async function getBackgroundOutputResponse(
	sessionId: string,
	bgSession: BackgroundSession,
	cwd: string,
	opts: {
		outputLines?: number;
		outputMaxChars?: number;
		outputOffset?: number;
		drain?: boolean;
		incremental?: boolean;
	},
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}> {
	const queried = await queryBackgroundSessionOutput(sessionId, bgSession, cwd, opts);
	const { truncatedNote, hasMoreNote } = outputDisplayNotes(queried.truncated, queried.totalBytes, queried.hasMore);
	const outputBlock = {
		output: queried.output,
		truncated: queried.truncated,
		totalBytes: queried.totalBytes,
		totalLines: queried.totalLines,
		hasMore: queried.hasMore,
	};
	if (queried.lastResult) {
		return {
			content: [
				{
					type: "text",
					text: `Session ${sessionId} ${queried.status} after ${formatDurationMs(queried.runtime)}${queried.output ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${queried.output}` : ""}`,
				},
			],
			details: completedSessionQueryDetails(sessionId, queried.status, queried.runtime, outputBlock, queried.lastResult),
		};
	}
	return {
		content: [
			{
				type: "text",
				text: `Session ${sessionId} ${queried.status} (${formatDurationMs(queried.runtime)})${queried.output ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${queried.output}` : ""}`,
			},
		],
		details: {
			sessionId,
			status: queried.status,
			runtime: queried.runtime,
			...outputBlock,
			outputTruncated: queried.truncated,
			outputTotalBytes: queried.totalBytes,
			outputTotalLines: queried.totalLines,
			hasOutput: queried.output.length > 0,
		},
	};
}

async function resolveHandoffForCompletion(
	info: HeadlessCompletionInfo,
	opts?: {
		session?: TerminalSession;
		config?: InteractiveShellConfig;
		command?: string;
		cwd?: string;
		handoff?: HandoffParamOverrides;
		storedResult?: { current: ActiveSessionResult | undefined };
	},
): Promise<Pick<ActiveSessionResult, "handoffPreview" | "handoff">> {
	const result = opts?.storedResult?.current;
	if (result) {
		return { handoffPreview: result.handoffPreview, handoff: result.handoff };
	}
	if (opts?.session && opts.config && opts.command) {
		return buildHandoffArtifacts(
			opts.session,
			handoffWhenFromCompletion(info),
			opts.config,
			{ command: opts.command, cwd: opts.cwd },
			opts.handoff,
		);
	}
	return {};
}

function makeMonitorCompletionCallback(
	pi: ExtensionAPI,
	id: string,
	startTime: number,
	opts?: {
		session?: TerminalSession;
		config?: InteractiveShellConfig;
		command?: string;
		cwd?: string;
		handoff?: HandoffParamOverrides;
		storedResult?: { current: ActiveSessionResult | undefined };
	},
): (info: HeadlessCompletionInfo) => void {
	return (info) => {
		void (async () => {
			const result = opts?.storedResult?.current;
			const handoff = await resolveHandoffForCompletion(info, opts);
			const wasAgentHandled = coordinator.consumeAgentHandledCompletion(id);
			if (!wasAgentHandled) {
				const duration = formatDuration(Date.now() - startTime);
				const content = buildDispatchNotification(id, info, duration);
				pi.sendMessage(
					{
						customType: "interactive-shell-transfer",
						content,
						display: true,
						details: { sessionId: id, duration, ...info, ...result, ...handoff },
					},
					{ triggerTurn: true },
				);
				pi.events.emit("interactive-shell:transfer", { sessionId: id, ...info, ...result, ...handoff });
			}
			sessionManager.unregisterActive(id, false);
			coordinator.deleteMonitor(id);
			clearHandoffContext(id);
			scheduleMonitorHistoryCleanup(id);
			sessionManager.scheduleCleanup(id, 5 * 60 * 1000);
		})().catch((error) => {
			console.error("interactive-shell: monitor completion callback failed:", error);
		});
	};
}

function resolveMonitorTerminalReason(info: HeadlessCompletionInfo, override?: MonitorTerminalReason): MonitorTerminalReason {
	if (override) return override;
	if (info.timedOut) return "timed-out";
	if (info.cancelled) return "stopped";
	if (info.exitCode === 0) return "stream-ended";
	return "script-failed";
}

function makeStructuredMonitorCompletionCallback(pi: ExtensionAPI, id: string): (info: HeadlessCompletionInfo) => void {
	return (info) => {
		const reason = resolveMonitorTerminalReason(info, coordinator.consumePendingMonitorReason(id));
		const state = coordinator.finalizeMonitorSession(id, { exitCode: info.exitCode, signal: info.signal }, reason);
		const wasAgentHandled = coordinator.consumeAgentHandledCompletion(id);
		if (!wasAgentHandled && state) {
			const content = buildMonitorLifecycleNotification(state);
			pi.sendMessage(
				{
					customType: "interactive-shell-monitor-lifecycle",
					content,
					display: true,
					details: { sessionId: id, state, completion: info },
				},
				{ triggerTurn: true },
			);
			pi.events.emit("interactive-shell:monitor-lifecycle", { sessionId: id, state, completion: info });
		}
		sessionManager.unregisterActive(id, false);
		coordinator.deleteMonitor(id);
		scheduleMonitorHistoryCleanup(id);
		sessionManager.scheduleCleanup(id, 5 * 60 * 1000);
	};
}

type CompiledMonitorConfig = {
	runtime: MonitorRuntimeConfig;
	persistence: {
		stopAfterFirstEvent: boolean;
		maxEvents?: number;
	};
	fileWatch?: Required<MonitorFileWatchConfig>;
	detector?: {
		detectorCommand: string;
		timeoutMs: number;
	};
	publicConfig: MonitorConfig;
};

type DetectorDecision = {
	emit: boolean;
	triggerId?: string;
	eventType?: string;
	matchedText?: string;
	lineOrDiff?: string;
};

function buildPollDiffLoopCommand(command: string, intervalMs: number): string {
	if (process.platform === "win32") {
		const seconds = Math.max(1, Math.ceil(intervalMs / 1000));
		return `for /L %i in (0,0,1) do (${command} & timeout /t ${seconds} /nobreak >nul)`;
	}
	const seconds = Math.max(0.25, intervalMs / 1000);
	const roundedSeconds = Number(seconds.toFixed(3));
	return `while true; do ${command}; sleep ${roundedSeconds}; done`;
}

function shellQuote(value: string): string {
	if (process.platform === "win32") {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildFileWatchCommand(fileWatch: Required<MonitorFileWatchConfig>): string {
	const script = `
import("node:fs").then((fs) => {
  const watchPath = process.argv[1];
  const recursive = process.argv[2] === "1";
  const allowed = new Set((process.argv[3] || "rename,change").split(",").filter(Boolean));
  function emit(eventType, filename) {
    if (!allowed.has(eventType)) return;
    const name = filename ? String(filename) : ".";
    process.stdout.write(eventType.toUpperCase() + " " + name + "\\n");
  }
  let watcher;
  try {
    watcher = fs.watch(watchPath, { recursive }, (eventType, filename) => emit(eventType, filename));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("file-watch failed: " + message);
    process.exit(1);
  }
  watcher.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("file-watch error: " + message);
    process.exit(1);
  });
  process.stdin.resume();
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
`.trim();

	const encoded = Buffer.from(script, "utf8").toString("base64");
	const eventCsv = fileWatch.events.join(",");
	return `${shellQuote(process.execPath)} -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))" ${shellQuote(fileWatch.path)} ${fileWatch.recursive ? "1" : "0"} ${shellQuote(eventCsv)}`;
}

function compareThreshold(value: number, op: MonitorThresholdOperator, expected: number): boolean {
	if (op === "lt") return value < expected;
	if (op === "lte") return value <= expected;
	if (op === "gt") return value > expected;
	return value >= expected;
}

function parseRegexPattern(value: string): { ok: true; regex: RegExp } | { ok: false; error: string } {
	const trimmed = value.trim();
	if (!trimmed) {
		return { ok: false, error: "Regex pattern cannot be empty." };
	}

	const literal = /^\/(.+)\/([A-Za-z]*)$/.exec(trimmed);
	let source = trimmed;
	let flags = "";
	if (literal) {
		if (!/^[dgimsuvy]*$/i.test(literal[2])) {
			return { ok: false, error: `Invalid regex flags: ${literal[2]}` };
		}
		source = literal[1];
		flags = literal[2].replace(/[gy]/gi, "");
	}

	try {
		return { ok: true, regex: new RegExp(source, flags) };
	} catch (error) {
		if (error instanceof Error) {
			return { ok: false, error: `Invalid regex '${value}': ${error.message}` };
		}
		return { ok: false, error: `Invalid regex '${value}'.` };
	}
}

function compileMonitorTrigger(
	trigger: MonitorTriggerConfig,
	index: number,
): { ok: true; compiled: MonitorTriggerMatcher } | { ok: false; error: string } {
	const id = trigger.id?.trim();
	if (!id) {
		return { ok: false, error: `monitor.triggers[${index}] requires non-empty id.` };
	}

	const hasLiteral = typeof trigger.literal === "string";
	const hasRegex = typeof trigger.regex === "string";
	if ((hasLiteral ? 1 : 0) + (hasRegex ? 1 : 0) !== 1) {
		return { ok: false, error: `monitor.triggers[${index}] must define exactly one matcher: literal or regex.` };
	}

	if (trigger.threshold && !hasRegex) {
		return { ok: false, error: `monitor.triggers[${index}].threshold requires regex matcher.` };
	}

	if (hasLiteral) {
		const literal = trigger.literal!.trim();
		if (!literal) {
			return { ok: false, error: `monitor.triggers[${index}].literal cannot be empty.` };
		}
		return {
			ok: true,
			compiled: {
				id,
				cooldownMs: trigger.cooldownMs,
				match: (input: string) => {
					const idx = input.indexOf(literal);
					if (idx === -1) return undefined;
					return input.slice(idx, idx + literal.length);
				},
			},
		};
	}

	const parsed = parseRegexPattern(trigger.regex!);
	if (!parsed.ok) {
		return { ok: false, error: `monitor.triggers[${index}].regex ${parsed.error}` };
	}

	const threshold = trigger.threshold;
	if (threshold) {
		if (!Number.isInteger(threshold.captureGroup) || threshold.captureGroup < 1) {
			return { ok: false, error: `monitor.triggers[${index}].threshold.captureGroup must be an integer >= 1.` };
		}
		if (!["lt", "lte", "gt", "gte"].includes(threshold.op)) {
			return { ok: false, error: `monitor.triggers[${index}].threshold.op must be one of: lt, lte, gt, gte.` };
		}
		if (!Number.isFinite(threshold.value)) {
			return { ok: false, error: `monitor.triggers[${index}].threshold.value must be a finite number.` };
		}
	}

	return {
		ok: true,
		compiled: {
			id,
			cooldownMs: trigger.cooldownMs,
			match: (input: string) => {
				parsed.regex.lastIndex = 0;
				const match = parsed.regex.exec(input);
				if (!match) return undefined;
				if (!threshold) return match[0];
				const captured = match[threshold.captureGroup];
				if (captured === undefined) return undefined;
				const numeric = Number(captured);
				if (!Number.isFinite(numeric)) return undefined;
				if (!compareThreshold(numeric, threshold.op, threshold.value)) return undefined;
				return match[0];
			},
		},
	};
}

function compileMonitorConfig(
	raw: MonitorConfig | undefined,
): { ok: true; compiled: CompiledMonitorConfig } | { ok: false; error: string } {
	if (!raw) {
		return { ok: false, error: "mode='monitor' requires monitor configuration." };
	}

	const strategy: MonitorStrategy = raw.strategy ?? "stream";
	if (strategy !== "stream" && strategy !== "poll-diff" && strategy !== "file-watch") {
		return { ok: false, error: `Unsupported monitor.strategy: ${String(raw.strategy)}` };
	}

	if (!Array.isArray(raw.triggers) || raw.triggers.length === 0) {
		return { ok: false, error: "monitor.triggers must contain at least one trigger." };
	}

	const ids = new Set<string>();
	const compiledTriggers: MonitorTriggerMatcher[] = [];
	for (let i = 0; i < raw.triggers.length; i++) {
		const trigger = raw.triggers[i];
		const compiled = compileMonitorTrigger(trigger, i);
		if (!compiled.ok) return compiled;
		if (ids.has(compiled.compiled.id)) {
			return { ok: false, error: `Duplicate monitor trigger id: ${compiled.compiled.id}` };
		}
		ids.add(compiled.compiled.id);
		compiledTriggers.push(compiled.compiled);
	}

	let fileWatch: Required<MonitorFileWatchConfig> | undefined;
	if (strategy === "file-watch") {
		if (!raw.fileWatch) {
			return { ok: false, error: "monitor.fileWatch is required when monitor.strategy='file-watch'." };
		}
		const watchPath = raw.fileWatch.path?.trim();
		if (!watchPath) {
			return { ok: false, error: "monitor.fileWatch.path must be a non-empty string." };
		}
		const watchEvents = raw.fileWatch.events ?? ["rename", "change"];
		if (!Array.isArray(watchEvents) || watchEvents.length === 0) {
			return { ok: false, error: "monitor.fileWatch.events must contain at least one event." };
		}
		for (const eventName of watchEvents) {
			if (eventName !== "rename" && eventName !== "change") {
				return { ok: false, error: `Unsupported monitor.fileWatch event: ${String(eventName)}. Use 'rename' or 'change'.` };
			}
		}
		fileWatch = {
			path: watchPath,
			recursive: raw.fileWatch.recursive === true,
			events: Array.from(new Set(watchEvents)),
		};
	} else if (raw.fileWatch) {
		return { ok: false, error: "monitor.fileWatch is only valid when monitor.strategy='file-watch'." };
	}

	if (strategy !== "poll-diff" && raw.poll) {
		return { ok: false, error: "monitor.poll is only valid when monitor.strategy='poll-diff'." };
	}

	const pollIntervalMs = Math.max(250, Math.trunc(raw.poll?.intervalMs ?? 5000));
	const dedupeExactLine = raw.throttle?.dedupeExactLine !== false;
	const cooldownMs = raw.throttle?.cooldownMs !== undefined ? Math.max(0, Math.trunc(raw.throttle.cooldownMs)) : undefined;
	const stopAfterFirstEvent = raw.persistence?.stopAfterFirstEvent === true;
	const maxEvents = raw.persistence?.maxEvents !== undefined ? Math.max(1, Math.trunc(raw.persistence.maxEvents)) : undefined;

	const detectorCommand = raw.detector?.detectorCommand?.trim();
	const detector = detectorCommand
		? {
				detectorCommand,
				timeoutMs: Math.max(100, Math.trunc(raw.detector?.timeoutMs ?? 3000)),
			}
		: undefined;

	const publicConfig: MonitorConfig = {
		strategy,
		triggers: raw.triggers,
		fileWatch,
		poll: strategy === "poll-diff" ? { intervalMs: pollIntervalMs } : undefined,
		persistence: {
			stopAfterFirstEvent,
			maxEvents,
		},
		throttle: {
			dedupeExactLine,
			cooldownMs,
		},
		detector: detector
			? {
					detectorCommand: detector.detectorCommand,
					timeoutMs: detector.timeoutMs,
				}
			: undefined,
	};

	return {
		ok: true,
		compiled: {
			runtime: {
				strategy,
				triggers: compiledTriggers,
				pollIntervalMs,
				dedupeExactLine,
				cooldownMs,
			},
			persistence: {
				stopAfterFirstEvent,
				maxEvents,
			},
			fileWatch,
			detector,
			publicConfig,
		},
	};
}

async function runDetectorCommand(
	detector: NonNullable<CompiledMonitorConfig["detector"]>,
	candidate: MonitorEventPayload,
	cwd?: string,
): Promise<DetectorDecision> {
	return new Promise<DetectorDecision>((resolve, reject) => {
		const shell = process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : process.env.SHELL || "/bin/sh";
		const args = process.platform === "win32" ? ["/d", "/s", "/c", detector.detectorCommand] : ["-c", detector.detectorCommand];

		const child = spawnChildProcess(shell, args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});

		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`detectorCommand timed out after ${detector.timeoutMs}ms`));
		}, detector.timeoutMs);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});

		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});

		child.on("exit", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(`detectorCommand exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
				return;
			}
			const raw = stdout.trim();
			if (!raw) {
				resolve({ emit: true });
				return;
			}
			try {
				const parsed = JSON.parse(raw) as DetectorDecision | boolean;
				if (typeof parsed === "boolean") {
					resolve({ emit: parsed });
					return;
				}
				resolve({
					emit: parsed.emit !== false,
					triggerId: parsed.triggerId,
					eventType: parsed.eventType,
					matchedText: parsed.matchedText,
					lineOrDiff: parsed.lineOrDiff,
				});
			} catch (error) {
				reject(new Error(`detectorCommand returned invalid JSON: ${(error as Error).message}`));
			}
		});

		child.stdin.write(`${JSON.stringify(candidate)}\n`);
		child.stdin.end();
	});
}

function makeMonitorEventCallback(
	pi: ExtensionAPI,
	sessionId: string,
	config: CompiledMonitorConfig,
	cwd?: string,
): (event: MonitorMatchInfo) => void {
	let queue = Promise.resolve();
	let emitted = 0;
	let stopped = false;

	return (event) => {
		queue = queue
			.then(async () => {
				if (stopped) return;
				if (!coordinator.getMonitor(sessionId)) {
					stopped = true;
					return;
				}

				let candidate: Omit<MonitorEventPayload, "eventId" | "timestamp"> = {
					sessionId,
					strategy: event.strategy,
					triggerId: event.triggerId,
					eventType: event.eventType,
					matchedText: event.matchedText,
					lineOrDiff: event.lineOrDiff,
					stream: event.stream,
				};

				if (config.detector) {
					try {
						const detectorPreview: MonitorEventPayload = {
							...candidate,
							eventId: 0,
							timestamp: new Date().toISOString(),
						};
						const decision = await runDetectorCommand(config.detector, detectorPreview, cwd);
						if (!decision.emit) return;
						if (decision.triggerId) candidate = { ...candidate, triggerId: decision.triggerId };
						if (decision.eventType) candidate = { ...candidate, eventType: decision.eventType };
						if (decision.matchedText) candidate = { ...candidate, matchedText: decision.matchedText };
						if (decision.lineOrDiff) candidate = { ...candidate, lineOrDiff: decision.lineOrDiff };
					} catch (error) {
						console.error(`interactive-shell: detectorCommand failed for ${sessionId}:`, error);
						return;
					}
				}

				const payload = coordinator.recordMonitorEvent(candidate);
				const content = buildMonitorEventNotification(payload);
				pi.sendMessage(
					{
						customType: "interactive-shell-monitor-event",
						content,
						display: true,
						details: payload,
					},
					{ triggerTurn: true },
				);
				pi.events.emit("interactive-shell:monitor-event", payload);

				emitted += 1;
				if (
					config.persistence.stopAfterFirstEvent ||
					(config.persistence.maxEvents !== undefined && emitted >= config.persistence.maxEvents)
				) {
					stopped = true;
					coordinator.markMonitorStopping(sessionId, "stopped");
					sessionManager.getActive(sessionId)?.kill();
				}
			})
			.catch((error) => {
				console.error(`interactive-shell: monitor callback queue error for ${sessionId}:`, error);
			});
	};
}

/** Shared write/sendKeys/paste/focus bindings for registered active sessions. */
function sessionIoBindings(session: TerminalSession) {
	return {
		write: (data: string) => session.write(data),
		sendKeys: (keys: string[]) => session.sendKeys?.(keys),
		paste: (text: string) => session.paste?.(text),
		writeAsync: session.writeAsync ? (data: string) => session.writeAsync!(data) : undefined,
		sendKeysAsync: session.sendKeysAsync ? (keys: string[]) => session.sendKeysAsync!(keys) : undefined,
		pasteAsync: session.pasteAsync ? (text: string) => session.pasteAsync!(text) : undefined,
		sendInputSequence: session.sendInputSequence
			? (options: { text?: string; paste?: string; keys?: string[]; submit?: boolean }) => session.sendInputSequence!(options)
			: undefined,
		focus: () => session.focus?.(),
	};
}

function registerHeadlessActive(
	id: string,
	command: string,
	reason: string | undefined,
	session: TerminalSession,
	monitor: HeadlessDispatchMonitor,
	startTime: number,
	config: InteractiveShellConfig,
	status: "running" | "monitoring" = "running",
	storedResult?: { current: ActiveSessionResult | undefined },
): void {
	// Share query state with attach / post-unregister sessionId fallback so incremental
	// cursors survive the active → background-only transition after the first result poll.
	const queryState = sessionManager.getQueryState(id);
	coordinator.setMonitor(id, monitor);
	const getCompletionOutput = () => storedResult?.current?.completionOutput ?? monitor.getResult()?.completionOutput;

	sessionManager.registerActive({
		id,
		command,
		reason,
		...sessionIoBindings(session),
		kill: () => {
			const monitorState = coordinator.getMonitorSessionState(id);
			if (monitorState?.status === "running") {
				coordinator.markMonitorStopping(id, "stopped");
			}
			const liveMonitor = coordinator.getMonitor(id);
			// Route through the monitor completion pipeline so storedResult / onComplete
			// finalize; agent-handled markers suppress the user-facing completion turn.
			if (liveMonitor && !liveMonitor.disposed) {
				liveMonitor.cancel();
				return;
			}
			session.kill();
			coordinator.disposeMonitor(id);
			scheduleMonitorHistoryCleanup(id);
			sessionManager.remove(id);
			sessionManager.unregisterActive(id, true);
		},
		// Kitty sessions already run as detached tabs.
		background: () => {},
		getOutput: (opts) => getSessionOutput(session, config, queryState, opts, getCompletionOutput()),
		getStatus: () => (session.exited ? "exited" : status),
		getRuntime: () => Date.now() - startTime,
		getResult: () => storedResult?.current ?? monitor.getResult(),
		setQuietThreshold: (thresholdMs) => monitor.setQuietThreshold(thresholdMs),
		onComplete: (cb) => monitor.registerCompleteCallback(cb),
	});
}

/**
 * Hands-free: agent-polled supervision (no dispatch completion turn).
 * Uses HeadlessDispatchMonitor for timeout / autoExitOnQuiet; optional progress updates.
 */
function registerHandsFreeActive(
	pi: ExtensionAPI,
	id: string,
	command: string,
	reason: string | undefined,
	session: TerminalSession,
	monitor: HeadlessDispatchMonitor,
	startTime: number,
	config: InteractiveShellConfig,
	options: {
		updateMode: "on-quiet" | "interval";
		updateInterval: number;
		quietThreshold: number;
		updateMaxChars: number;
		maxTotalChars: number;
		emitProgressUpdates: boolean;
	},
	storedResult: { current: ActiveSessionResult | undefined },
): void {
	const queryState = sessionManager.getQueryState(id);
	coordinator.setMonitor(id, monitor);

	let updateMode = options.updateMode;
	let currentUpdateInterval = options.updateInterval;
	let currentQuietThreshold = options.quietThreshold;
	let totalCharsSent = 0;
	let budgetExhausted = false;
	let hasUnsentData = false;
	let handsFreeInterval: ReturnType<typeof setInterval> | null = null;
	let handsFreeInitialTimeout: ReturnType<typeof setTimeout> | null = null;
	let progressQuietTimer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;
	let completed = false;
	let unsubscribeProgressData: (() => void) | undefined;

	const stopProgressTimers = () => {
		if (handsFreeInitialTimeout) {
			clearTimeout(handsFreeInitialTimeout);
			handsFreeInitialTimeout = null;
		}
		if (handsFreeInterval) {
			clearInterval(handsFreeInterval);
			handsFreeInterval = null;
		}
		if (progressQuietTimer) {
			clearTimeout(progressQuietTimer);
			progressQuietTimer = null;
		}
		unsubscribeProgressData?.();
		unsubscribeProgressData = undefined;
	};

	const emitProgress = (status: HandsFreeUpdate["status"] = "running", force = false) => {
		if (!options.emitProgressUpdates || (disposed && !force)) return;
		const maxChars = options.updateMaxChars;
		const maxTotalChars = options.maxTotalChars;
		let tail: string[] = [];
		let truncated = false;
		if (status === "running" && !budgetExhausted) {
			let newOutput = session.getRawStream({ sinceLast: true, stripAnsi: true });
			if (newOutput.length > maxChars) {
				newOutput = newOutput.slice(-maxChars);
				truncated = true;
			}
			if (totalCharsSent + newOutput.length > maxTotalChars) {
				const remaining = maxTotalChars - totalCharsSent;
				if (remaining > 0) {
					newOutput = newOutput.slice(-remaining);
					truncated = true;
				} else {
					newOutput = "";
				}
				budgetExhausted = true;
			}
			if (newOutput.length > 0) {
				totalCharsSent += newOutput.length;
				tail = newOutput.split("\n");
			}
		}
		const update: HandsFreeUpdate = {
			status,
			sessionId: id,
			runtime: Date.now() - startTime,
			tail,
			tailTruncated: truncated,
			totalCharsSent,
			budgetExhausted,
		};
		makeNonBlockingUpdateHandler(pi)(update);
	};

	const resetProgressQuietTimer = () => {
		if (progressQuietTimer) {
			clearTimeout(progressQuietTimer);
			progressQuietTimer = null;
		}
		if (!options.emitProgressUpdates || updateMode !== "on-quiet" || disposed) return;
		progressQuietTimer = setTimeout(() => {
			progressQuietTimer = null;
			if (disposed || !hasUnsentData) return;
			emitProgress("running");
			hasUnsentData = false;
		}, currentQuietThreshold);
	};

	const tickProgressInterval = () => {
		if (disposed) return;
		if (updateMode === "on-quiet") {
			if (hasUnsentData) {
				emitProgress("running");
				hasUnsentData = false;
			}
			return;
		}
		emitProgress("running");
	};

	if (options.emitProgressUpdates) {
		unsubscribeProgressData = session.addDataListener((data) => {
			const visible = data.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
			if (visible.trim().length > 0 && updateMode === "on-quiet") {
				hasUnsentData = true;
				resetProgressQuietTimer();
			}
		});
		handsFreeInitialTimeout = setTimeout(() => {
			handsFreeInitialTimeout = null;
			if (!disposed) emitProgress("running");
		}, 2000);
		handsFreeInterval = setInterval(tickProgressInterval, currentUpdateInterval);
	}

	const completeHandsFree = () => {
		if (completed) return;
		completed = true;
		stopProgressTimers();
		const info = monitor.getResult();
		if (hasUnsentData) {
			emitProgress("running");
			hasUnsentData = false;
		}
		emitProgress(info?.cancelled ? "killed" : "exited", true);
		disposed = true;
	};

	monitor.registerCompleteCallback(completeHandsFree);

	sessionManager.registerActive({
		id,
		command,
		reason,
		...sessionIoBindings(session),
		kill: () => {
			// cancel() finalizes asynchronously (output capture). completeHandsFree is
			// registered as a monitor complete callback so it runs after cancelled is set.
			// Calling it here would race getResult() and emit "exited" instead of "killed".
			monitor.cancel();
		},
		// No-op: kitty sessions are already managed detached tabs.
		background: () => {},
		getOutput: (opts) =>
			getSessionOutput(session, config, queryState, opts, storedResult.current?.completionOutput ?? monitor.getResult()?.completionOutput),
		getStatus: () => {
			const result = storedResult.current ?? monitor.getResult();
			if (result?.cancelled) return "killed";
			if (result || session.exited) return "exited";
			return "running";
		},
		getRuntime: () => Date.now() - startTime,
		getResult: () => storedResult.current ?? monitor.getResult(),
		setUpdateInterval: (intervalMs) => {
			const clamped = Math.max(5000, Math.min(300000, Math.trunc(intervalMs)));
			if (clamped === currentUpdateInterval) return;
			currentUpdateInterval = clamped;
			if (handsFreeInterval) {
				clearInterval(handsFreeInterval);
				handsFreeInterval = setInterval(tickProgressInterval, currentUpdateInterval);
			}
		},
		setQuietThreshold: (thresholdMs) => {
			const clamped = Math.max(1000, Math.min(300000, Math.trunc(thresholdMs)));
			currentQuietThreshold = clamped;
			monitor.setQuietThreshold(clamped);
			if (progressQuietTimer) resetProgressQuietTimer();
		},
		onComplete: (cb) => monitor.registerCompleteCallback(cb),
	});
}

function registerRunningActive(
	id: string,
	command: string,
	reason: string | undefined,
	session: TerminalSession,
	startTime: number,
	config: InteractiveShellConfig,
	onComplete: () => void,
	storedResult?: { current: ActiveSessionResult | undefined },
): void {
	const queryState = sessionManager.getQueryState(id);
	sessionManager.registerActive({
		id,
		command,
		reason,
		...sessionIoBindings(session),
		kill: () => {
			session.kill();
		},
		// No-op: kitty sessions are already managed detached tabs.
		background: () => {},
		getOutput: (opts) => getSessionOutput(session, config, queryState, opts, storedResult?.current?.completionOutput),
		getStatus: () => {
			const result = storedResult?.current;
			if (result?.cancelled) return "killed";
			if (result?.timedOut || result || session.exited) return "exited";
			return "running";
		},
		getRuntime: () => Date.now() - startTime,
		getResult: () => {
			if (storedResult?.current) return storedResult.current;
			if (session.exited) {
				return {
					exitCode: session.exitCode,
					signal: session.signal,
					backgrounded: false,
					cancelled: false,
				};
			}
			return undefined;
		},
		onComplete: (cb) => session.addExitListener(() => cb()),
	});
	session.addExitListener(() => {
		onComplete();
	});
}

function sessionTitle(config: InteractiveShellConfig, sessionId: string): string {
	return `${config.kitty?.tabTitlePrefix ?? "pi-shell"}: ${sessionId}`;
}

async function sendStructuredInput(
	session: ReturnType<typeof sessionManager.getActive>,
	sessionId: string,
	input: string | { text?: string; keys?: string[]; paste?: string; hex?: string[] } | undefined,
	submit?: boolean,
): Promise<boolean> {
	if (!session) return false;
	const hasNativeInput =
		typeof session.write === "function" || typeof session.sendKeys === "function" || typeof session.paste === "function";
	if (!hasNativeInput) {
		const translated = input !== undefined ? translateInput(input) : "";
		return sessionManager.writeToActive(sessionId, submit ? `${translated}\r` : translated);
	}
	const write =
		typeof session.write === "function"
			? async (data: string) => {
					if (typeof session.writeAsync === "function") {
						await session.writeAsync(data);
					} else {
						session.write(data);
					}
					return true;
				}
			: (data: string) => sessionManager.writeToActive(sessionId, data);
	try {
		if (input === undefined) {
			await write(submit ? "\r" : "");
			return true;
		}
		if (typeof input === "string") {
			await write(submit ? `${input}\r` : input);
			return true;
		}
		let raw = "";
		if (input.hex?.length) {
			raw += translateInput({ hex: input.hex });
		}
		if (input.text) {
			raw += input.text;
		}
		// Prefer a single ordered RC batch (paste + keys + Enter on one socket) so kitty
		// cannot process submit before paste when connections are independent.
		if (typeof session.sendInputSequence === "function") {
			await session.sendInputSequence({
				text: raw || undefined,
				paste: input.paste,
				keys: input.keys,
				submit,
			});
			return true;
		}
		if (raw) {
			// Keep submit on the text path when possible (same as plain-string input).
			const trailingKeys = input.keys ?? [];
			const submitViaText = Boolean(submit) && trailingKeys.length === 0 && !input.paste;
			await write(submitViaText ? `${raw}\r` : raw);
			if (submitViaText) return true;
		}
		if (input.paste) {
			const trailingKeys = input.keys ?? [];
			const submitViaText = Boolean(submit) && trailingKeys.length === 0;
			if (typeof session.pasteAsync === "function") {
				await session.pasteAsync(input.paste);
			} else if (typeof session.paste === "function") {
				session.paste(input.paste);
			} else {
				await write(translateInput({ paste: input.paste }));
			}
			// Fall back to text-path CR rather than a separate send-key when no other keys.
			if (submitViaText) {
				await write("\r");
				return true;
			}
		}
		const keys = [...(input.keys ?? [])];
		if (submit) keys.push("enter");
		if (keys.length > 0) {
			if (typeof session.sendKeysAsync === "function") {
				await session.sendKeysAsync(keys);
			} else if (typeof session.sendKeys === "function") {
				session.sendKeys(keys);
			} else {
				await write(translateInput({ keys }));
			}
		} else if (submit && !raw && !input.paste) {
			await write("\r");
		}
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`interactive-shell: failed to send input to session ${sessionId}:`, message);
		return false;
	}
}

function makeNonBlockingUpdateHandler(pi: ExtensionAPI): (update: HandsFreeUpdate) => void {
	return (update) => {
		pi.events.emit("interactive-shell:update", update);
		const message = buildHandsFreeUpdateMessage(update);
		if (!message) return;
		pi.sendMessage(
			{
				customType: "interactive-shell-update",
				content: message.content,
				display: true,
				details: message.details,
			},
			{ triggerTurn: true },
		);
	};
}

function appendWorktreeNotice(text: string, worktreePath: string | undefined): string {
	if (!worktreePath) return text;
	return `${text}\nWorktree left in place: ${worktreePath}`;
}

/**
 * Resolve a sessionId against the active table first, then background.
 * After the first completed-status poll unregisters active (agent-poll semantics),
 * subsequent sessionId / incremental / drain queries must still reach the kitty tab
 * via the background entry (P-1).
 */
function resolveSessionById(sessionId: string): {
	active: ActiveSession | undefined;
	background: BackgroundSession | undefined;
} {
	const active = sessionManager.getActive(sessionId);
	const background = sessionManager.hasBackground(sessionId) ? sessionManager.get(sessionId) : undefined;
	return { active, background };
}

/** After background reads, resume delayed cleanup when no headless monitor owns the session. */
function maybeRestartBackgroundCleanup(sessionId: string): void {
	const monitor = coordinator.getMonitor(sessionId);
	if (!monitor || monitor.disposed) {
		sessionManager.restartAutoCleanup(sessionId);
	}
}

function persistBackgroundResult(sessionId: string, result: ActiveSessionResult): void {
	sessionManager.setBackgroundResult(sessionId, result);
}

function statusFromBackground(bg: BackgroundSession): string {
	const result = bg.lastResult;
	if (result?.cancelled) return "killed";
	if (result?.timedOut) return "exited";
	if (result || bg.session.exited) return "exited";
	return "running";
}

async function queryBackgroundSessionOutput(
	sessionId: string,
	bg: BackgroundSession,
	ctxCwd: string,
	opts: {
		outputLines?: number;
		outputMaxChars?: number;
		outputOffset?: number;
		drain?: boolean;
		incremental?: boolean;
		skipRateLimit?: boolean;
	},
): Promise<{
	status: string;
	runtime: number;
	output: string;
	truncated: boolean;
	totalBytes: number;
	totalLines?: number;
	hasMore?: boolean;
	lastResult?: ActiveSessionResult;
}> {
	const config = loadConfig(ctxCwd);
	const queryState = sessionManager.getQueryState(sessionId);
	const { output, truncated, totalBytes, totalLines, hasMore } = await getSessionOutput(
		bg.session,
		config,
		queryState,
		{
			skipRateLimit: opts.skipRateLimit ?? true,
			lines: opts.outputLines,
			maxChars: opts.outputMaxChars,
			offset: opts.outputOffset,
			drain: opts.drain,
			incremental: opts.incremental,
		},
		// Default tail can reuse the exit-time snapshot; incremental/drain/offset need live/log paths.
		bg.lastResult?.completionOutput,
	);
	maybeRestartBackgroundCleanup(sessionId);
	return {
		status: statusFromBackground(bg),
		runtime: Date.now() - bg.startedAt.getTime(),
		output,
		truncated,
		totalBytes,
		totalLines,
		hasMore,
		lastResult: bg.lastResult,
	};
}

/**
 * After attach, re-register a lightweight active handle when the kitty session is still
 * running so sessionId settings/input keep working (main reattach re-opened an overlay).
 * Always read completion from background.lastResult / live monitor so post-completion
 * polls stay consistent after rehydrate.
 */
function rehydrateActiveFromBackground(sessionId: string, config: InteractiveShellConfig): void {
	if (sessionManager.getActive(sessionId)) return;
	if (!sessionManager.hasBackground(sessionId)) return;
	const bg = sessionManager.get(sessionId);
	if (!bg || bg.session.exited) return;

	const monitor = coordinator.getMonitor(sessionId);
	const startTime = bg.startedAt.getTime();
	const queryState = sessionManager.getQueryState(sessionId);
	const liveMonitor = () => {
		const current = coordinator.getMonitor(sessionId);
		return current && !current.disposed ? current : undefined;
	};

	sessionManager.registerActive({
		id: sessionId,
		command: bg.command,
		reason: bg.reason,
		...sessionIoBindings(bg.session),
		kill: () => {
			const mon = liveMonitor();
			if (mon) {
				mon.cancel();
				return;
			}
			bg.session.kill();
		},
		background: () => {},
		getOutput: (opts) =>
			getSessionOutput(
				bg.session,
				config,
				queryState,
				opts,
				bg.lastResult?.completionOutput ?? liveMonitor()?.getResult()?.completionOutput,
			),
		getStatus: () => {
			if (bg.lastResult?.cancelled) return "killed";
			if (bg.lastResult || bg.session.exited) return "exited";
			const monState = coordinator.getMonitorSessionState(sessionId);
			if (monState?.status === "running") return "monitoring";
			return "running";
		},
		getRuntime: () => Date.now() - startTime,
		getResult: () => {
			if (bg.lastResult) return bg.lastResult;
			const info = liveMonitor()?.getResult();
			if (!info) return undefined;
			return {
				exitCode: info.exitCode,
				signal: info.signal,
				timedOut: info.timedOut,
				cancelled: info.cancelled,
				completionOutput: info.completionOutput,
			};
		},
		setQuietThreshold: (thresholdMs) => {
			liveMonitor()?.setQuietThreshold(thresholdMs);
		},
		onComplete: (cb) => {
			const mon = liveMonitor();
			if (mon) {
				mon.registerCompleteCallback(cb);
				return;
			}
			bg.session.addExitListener(() => cb());
		},
	});
}

export default function interactiveShellExtension(pi: ExtensionAPI) {
	const startupConfig = loadConfig(process.cwd());
	const loadRuntimeConfig = (cwd: string): InteractiveShellConfig => {
		const config = loadConfig(cwd);
		return {
			...config,
			focusShortcut: startupConfig.focusShortcut,
			spawn: {
				...config.spawn,
				shortcut: startupConfig.spawn.shortcut,
			},
		};
	};
	const disposeStaleMonitor = (id: string, monitor: HeadlessDispatchMonitor | undefined): void => {
		if (!monitor || monitor.disposed) return;
		coordinator.disposeMonitor(id);
		coordinator.clearMonitorEvents(id);
		sessionManager.unregisterActive(id, false);
	};
	const spawnKittySession = async (ctx: ExtensionContext, request?: SpawnRequest): Promise<void> => {
		const config = loadRuntimeConfig(ctx.cwd);
		const spawn = resolveSpawn(config, ctx.cwd, request, () => ctx.sessionManager.getSessionFile());
		if (!spawn.ok) {
			ctx.ui.notify(spawn.error, "error");
			return;
		}

		const result = await startNewSession({
			ctx,
			command: spawn.spawn.command,
			cwd: spawn.spawn.cwd,
			reason: spawn.spawn.reason,
			mode: "interactive",
		});
		if (spawn.spawn.worktreePath) {
			ctx.ui.notify(`Worktree left in place: ${spawn.spawn.worktreePath}`, "info");
		}
		if (result.isError) {
			ctx.ui.notify(result.content[0]?.text ?? "Failed to start session.", "error");
		}
	};
	const startNewSession = async (params: {
		ctx: Pick<ExtensionContext, "ui" | "cwd" | "sessionManager"> & { hasUI?: boolean };
		command?: string;
		spawn?: SpawnRequest;
		cwd?: string;
		name?: string;
		reason?: string;
		mode?: "interactive" | "hands-free" | "dispatch" | "monitor";
		background?: boolean;
		handsFree?: ToolParams["handsFree"];
		handoffPreview?: ToolParams["handoffPreview"];
		handoffSnapshot?: ToolParams["handoffSnapshot"];
		timeout?: number;
		monitor?: ToolParams["monitor"];
		signal?: AbortSignal;
		onUpdate?: (update: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void;
		input?: ToolParams["input"];
		inputKeys?: ToolParams["inputKeys"];
		inputHex?: ToolParams["inputHex"];
		inputPaste?: ToolParams["inputPaste"];
		submit?: ToolParams["submit"];
	}): Promise<{ content: Array<{ type: "text"; text: string }>; details?: any; isError?: boolean }> => {
		const {
			ctx,
			command,
			spawn,
			cwd,
			name,
			reason,
			mode,
			background,
			handsFree,
			handoffPreview,
			handoffSnapshot,
			timeout,
			monitor,
			signal,
			onUpdate,
			input,
			inputKeys,
			inputHex,
			inputPaste,
			submit,
		} = params;
		const allowsGeneratedCommand = mode === "monitor" && monitor?.strategy === "file-watch";
		if (!command && !spawn && !allowsGeneratedCommand) {
			return {
				content: [{ type: "text", text: "One of 'command' or 'spawn' is required." }],
				isError: true,
			};
		}

		let effectiveCwd = cwd ?? ctx.cwd;
		const config = loadRuntimeConfig(effectiveCwd);
		const isMonitorMode = mode === "monitor";
		const handoffOpts = handoffOverridesFromParams(handoffPreview, handoffSnapshot);
		const hasStructuredInput = inputKeys?.length || inputHex?.length || inputPaste;
		const effectiveInput = hasStructuredInput ? { text: input, keys: inputKeys, hex: inputHex, paste: inputPaste } : input;

		if (background && mode !== "dispatch" && mode !== "monitor") {
			return {
				content: [{ type: "text", text: "background: true requires mode='dispatch' or mode='monitor' for new sessions." }],
				isError: true,
			};
		}

		let effectiveCommand = command;
		let effectiveReason = reason;
		let spawnWorktreePath: string | undefined;
		let spawnAgent: string | undefined;
		let spawnMode: string | undefined;
		if (spawn) {
			const resolvedSpawn = resolveSpawn(config, effectiveCwd, spawn, () => ctx.sessionManager.getSessionFile());
			if (!resolvedSpawn.ok) {
				return {
					content: [{ type: "text", text: resolvedSpawn.error }],
					isError: true,
				};
			}
			effectiveCommand = resolvedSpawn.spawn.command;
			effectiveCwd = resolvedSpawn.spawn.cwd;
			effectiveReason = effectiveReason ? `${effectiveReason} • ${resolvedSpawn.spawn.reason}` : resolvedSpawn.spawn.reason;
			spawnWorktreePath = resolvedSpawn.spawn.worktreePath;
			spawnAgent = resolvedSpawn.spawn.agent;
			spawnMode = resolvedSpawn.spawn.mode;
		}
		const expectsGeneratedCommand = isMonitorMode && monitor?.strategy === "file-watch";
		if (!effectiveCommand && !expectsGeneratedCommand) {
			return {
				content: [{ type: "text", text: "Failed to resolve the command to launch." }],
				isError: true,
			};
		}

		const launchSession = async (
			sessionId: string,
			commandToRun: string,
			focus: boolean,
		): Promise<{ ok: true; session: KittyTerminalSession } | { ok: false; error: string }> => {
			try {
				const session = new KittyTerminalSession(
					{
						id: sessionId,
						command: commandToRun,
						cwd: effectiveCwd,
						cols: 120,
						rows: 40,
						scrollback: config.scrollbackLines,
						focus,
						title: sessionTitle(config, sessionId),
					},
					config,
				);
				await session.ready;
				return { ok: true, session };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: `Failed to launch kitty session: ${message}` };
			}
		};

		if (isMonitorMode) {
			const compiledMonitor = compileMonitorConfig(monitor);
			if (!compiledMonitor.ok) {
				return {
					content: [{ type: "text", text: compiledMonitor.error }],
					isError: true,
				};
			}

			const id = generateSessionId(name);
			const strategy = compiledMonitor.compiled.runtime.strategy;
			const sessionCommand =
				strategy === "file-watch" ? `file-watch ${compiledMonitor.compiled.fileWatch?.path ?? "<unknown>"}` : effectiveCommand!;
			let monitorCommand = sessionCommand;
			if (strategy === "poll-diff") {
				monitorCommand = buildPollDiffLoopCommand(sessionCommand, compiledMonitor.compiled.runtime.pollIntervalMs);
			} else if (strategy === "file-watch") {
				monitorCommand = buildFileWatchCommand(compiledMonitor.compiled.fileWatch!);
			}
			const startTime = Date.now();
			const launched = await launchSession(id, monitorCommand, background !== true);
			if (!launched.ok) {
				releaseSessionId(id);
				return {
					content: [{ type: "text", text: appendWorktreeNotice(launched.error, spawnWorktreePath) }],
					isError: true,
					details: { error: "kitty_launch_failed", spawnAgent, spawnMode, spawnWorktreePath },
				};
			}
			const session = launched.session;
			sessionManager.add(sessionCommand, session, name, effectiveReason, { id, noAutoCleanup: true, startedAt: new Date(startTime) });

			coordinator.registerMonitorSession(id, compiledMonitor.compiled.publicConfig, new Date(startTime));
			const monitorRunner = new HeadlessDispatchMonitor(
				session,
				config,
				{
					autoExitOnQuiet: handsFree?.autoExitOnQuiet === true,
					quietThreshold: handsFree?.quietThreshold ?? config.handsFreeQuietThreshold,
					gracePeriod: handsFree?.gracePeriod ?? config.autoExitGracePeriod,
					timeout,
					startedAt: startTime,
					monitor: compiledMonitor.compiled.runtime,
					onMonitorEvent: makeMonitorEventCallback(pi, id, compiledMonitor.compiled, effectiveCwd),
				},
				makeStructuredMonitorCompletionCallback(pi, id),
			);
			registerHeadlessActive(id, sessionCommand, effectiveReason, session, monitorRunner, startTime, config, "monitoring");

			return {
				content: [
					{
						type: "text",
						text: appendWorktreeNotice(
							`Monitor started in background (id: ${id}).\nStrategy: ${compiledMonitor.compiled.publicConfig.strategy ?? "stream"}\nTriggers: ${compiledMonitor.compiled.publicConfig.triggers.map((trigger) => trigger.id).join(", ")}\nYou'll be notified when a trigger emits an event.`,
							spawnWorktreePath,
						),
					},
				],
				details: {
					sessionId: id,
					backgroundId: id,
					mode: "monitor",
					monitor: compiledMonitor.compiled.publicConfig,
					background: true,
					spawnAgent,
					spawnMode,
					spawnWorktreePath,
				},
			};
		}

		const sessionId = generateSessionId(name);
		const startTime = Date.now();
		const launched = await launchSession(sessionId, effectiveCommand!, background !== true);
		if (!launched.ok) {
			releaseSessionId(sessionId);
			return {
				content: [{ type: "text", text: appendWorktreeNotice(launched.error, spawnWorktreePath) }],
				isError: true,
				details: { error: "kitty_launch_failed", spawnAgent, spawnMode, spawnWorktreePath },
			};
		}
		const session = launched.session;
		const handoffContext = { command: effectiveCommand!, cwd: effectiveCwd };
		registerHandoffContext(sessionId, session, config, handoffContext, handoffOpts);

		// Send initial input (if any) to the freshly launched session before entering
		// mode-specific supervision. writeAsync/sendKeysAsync await this.ready so the
		// input lands once the tab is up; previously this was silently dropped for new
		// sessions (only the existing-session branch sent input).
		if (effectiveInput !== undefined || submit) {
			await sendStructuredInput(session, sessionId, effectiveInput, submit);
		}

		if (mode === "dispatch" || background) {
			sessionManager.add(effectiveCommand, session, name, effectiveReason, {
				id: sessionId,
				noAutoCleanup: true,
				startedAt: new Date(startTime),
			});
			const storedResult: { current: ActiveSessionResult | undefined } = { current: undefined };
			const monitor = new HeadlessDispatchMonitor(
				session,
				config,
				{
					autoExitOnQuiet: handsFree?.autoExitOnQuiet !== false,
					quietThreshold: handsFree?.quietThreshold ?? config.handsFreeQuietThreshold,
					gracePeriod: handsFree?.gracePeriod ?? config.autoExitGracePeriod,
					timeout,
					startedAt: startTime,
				},
				(info) => {
					void (async () => {
						const artifacts = await buildHandoffArtifacts(session, handoffWhenFromCompletion(info), config, handoffContext, handoffOpts);
						storedResult.current = {
							exitCode: info.exitCode,
							signal: info.signal,
							backgrounded: false,
							timedOut: info.timedOut,
							cancelled: info.cancelled ?? false,
							completionOutput: info.completionOutput,
							...artifacts,
						};
						persistBackgroundResult(sessionId, storedResult.current);
						makeMonitorCompletionCallback(pi, sessionId, startTime, {
							session,
							config,
							command: effectiveCommand,
							cwd: effectiveCwd,
							handoff: handoffOpts,
							storedResult,
						})(info);
					})();
				},
			);
			registerHeadlessActive(sessionId, effectiveCommand, effectiveReason, session, monitor, startTime, config, "running", storedResult);
			return {
				content: [
					{
						type: "text",
						text: appendWorktreeNotice(
							`Session dispatched in kitty (id: ${sessionId}).\nYou'll be notified when it completes.\nUse /attach ${sessionId} or interactive_shell({ sessionId: "${sessionId}" }) to inspect it.`,
							spawnWorktreePath,
						),
					},
				],
				details: {
					sessionId,
					backgroundId: sessionId,
					mode: mode ?? "dispatch",
					background: true,
					spawnAgent,
					spawnMode,
					spawnWorktreePath,
				},
			};
		}

		if (mode === "hands-free") {
			sessionManager.add(effectiveCommand, session, name, effectiveReason, {
				id: sessionId,
				noAutoCleanup: true,
				startedAt: new Date(startTime),
			});
			const storedResult: { current: ActiveSessionResult | undefined } = { current: undefined };
			// Hands-free: agent polls progress; do NOT fire dispatch-style completion turns.
			const monitor = new HeadlessDispatchMonitor(
				session,
				config,
				{
					autoExitOnQuiet: handsFree?.autoExitOnQuiet === true,
					quietThreshold: handsFree?.quietThreshold ?? config.handsFreeQuietThreshold,
					gracePeriod: handsFree?.gracePeriod ?? config.autoExitGracePeriod,
					timeout,
					startedAt: startTime,
				},
				(info) => {
					void (async () => {
						const artifacts = await buildHandoffArtifacts(session, handoffWhenFromCompletion(info), config, handoffContext, handoffOpts);
						storedResult.current = {
							exitCode: info.exitCode,
							signal: info.signal,
							backgrounded: false,
							timedOut: info.timedOut,
							cancelled: info.cancelled ?? false,
							completionOutput: info.completionOutput,
							...artifacts,
						};
						persistBackgroundResult(sessionId, storedResult.current);
						// Keep agent-poll semantics: no triggerTurn completion notification.
						// Leave active session registered so the agent can query result/handoff;
						// the first successful poll unregisters (see sessionId query path).
						// Result stays on background.lastResult for subsequent sessionId queries.
						scheduleHandsFreeExpiry(sessionId);
						coordinator.deleteMonitor(sessionId);
					})();
				},
			);
			registerHandsFreeActive(
				pi,
				sessionId,
				effectiveCommand!,
				effectiveReason,
				session,
				monitor,
				startTime,
				config,
				{
					updateMode: handsFree?.updateMode ?? config.handsFreeUpdateMode,
					updateInterval: handsFree?.updateInterval ?? config.handsFreeUpdateInterval,
					quietThreshold: handsFree?.quietThreshold ?? config.handsFreeQuietThreshold,
					updateMaxChars: handsFree?.updateMaxChars ?? config.handsFreeUpdateMaxChars,
					maxTotalChars: handsFree?.maxTotalChars ?? config.handsFreeMaxTotalChars,
					emitProgressUpdates: true,
				},
				storedResult,
			);
			return {
				content: [
					{
						type: "text",
						text: appendWorktreeNotice(
							`Session started in kitty: ${sessionId}\nCommand: ${effectiveCommand}\n\nUse interactive_shell({ sessionId: "${sessionId}" }) to check status/output.\nUse interactive_shell({ sessionId: "${sessionId}", kill: true }) to end when done.`,
							spawnWorktreePath,
						),
					},
				],
				details: {
					sessionId,
					status: "running",
					command: effectiveCommand,
					reason: effectiveReason,
					mode: "hands-free",
					spawnAgent,
					spawnMode,
					spawnWorktreePath,
				},
			};
		}

		// Interactive mode: blocks the agent turn until the kitty session exits.
		onUpdate?.({
			content: [{ type: "text", text: appendWorktreeNotice(`Opened kitty session: ${effectiveCommand}`, spawnWorktreePath) }],
			details: { sessionId, exitCode: null, backgrounded: false, cancelled: false },
		});
		sessionManager.add(effectiveCommand, session, name, effectiveReason, {
			id: sessionId,
			noAutoCleanup: true,
			startedAt: new Date(startTime),
		});
		const storedResult: { current: ActiveSessionResult | undefined } = { current: undefined };
		let settled = false;
		const result = await new Promise<InteractiveShellResult>((resolve) => {
			let removeAbortListener: (() => void) | undefined;
			let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
			let pendingReason: "exit" | "kill" | "timeout" | undefined;
			const finish = (partial: InteractiveShellResult) => {
				if (settled) return;
				settled = true;
				removeAbortListener?.();
				if (timeoutTimer) {
					clearTimeout(timeoutTimer);
					timeoutTimer = undefined;
				}
				void (async () => {
					const when = handoffWhenFromCompletion(partial);
					// For abort/timeout, kill first and wait briefly so shutdown output / real
					// exit codes can land before we capture handoff artifacts.
					if ((when === "kill" || when === "timeout") && !session.exited) {
						session.kill();
						const graceMs = Math.min(config.kitty?.killGraceMs ?? 5000, 5000);
						const deadline = Date.now() + graceMs;
						while (!session.exited && Date.now() < deadline) {
							await new Promise((r) => setTimeout(r, 50));
						}
					}
					const artifacts = await buildHandoffArtifacts(session, when, config, handoffContext, handoffOpts);
					const completionOutput = partial.completionOutput ?? (await captureCompletionOutput(session, config));
					const full: InteractiveShellResult = {
						...partial,
						// Prefer real exit status if kill completed within grace.
						exitCode: session.exited ? session.exitCode : partial.exitCode,
						signal: session.exited ? session.signal : partial.signal,
						completionOutput,
						...artifacts,
					};
					storedResult.current = full;
					persistBackgroundResult(sessionId, full);
					sessionManager.unregisterActive(sessionId, false);
					// Keep handoff context until cleanup/dismiss so late queries can still resolve artifacts.
					sessionManager.scheduleCleanup(sessionId, 5 * 60 * 1000);
					resolve(full);
				})();
			};
			registerRunningActive(
				sessionId,
				effectiveCommand!,
				effectiveReason,
				session,
				startTime,
				config,
				() => {
					// Natural exit wins over a pending abort/timeout reason.
					if (pendingReason === "timeout") {
						finish({
							exitCode: session.exitCode,
							signal: session.signal,
							backgrounded: false,
							cancelled: false,
							timedOut: true,
							sessionId,
						});
						return;
					}
					if (pendingReason === "kill") {
						finish({
							exitCode: session.exitCode,
							signal: session.signal,
							backgrounded: false,
							cancelled: true,
							sessionId,
						});
						return;
					}
					finish({
						exitCode: session.exitCode,
						signal: session.signal,
						backgrounded: false,
						cancelled: false,
						sessionId,
					});
				},
				storedResult,
			);
			const abortInteractive = () => {
				if (session.exited || settled) return;
				pendingReason = "kill";
				finish({
					exitCode: null,
					backgrounded: false,
					cancelled: true,
					sessionId,
				});
			};
			if (signal) {
				if (signal.aborted) {
					abortInteractive();
				} else {
					signal.addEventListener("abort", abortInteractive, { once: true });
					removeAbortListener = () => signal.removeEventListener("abort", abortInteractive);
				}
			}
			if (timeout && timeout > 0) {
				timeoutTimer = setTimeout(() => {
					timeoutTimer = undefined;
					if (!session.exited && !settled) {
						pendingReason = "timeout";
						finish({
							exitCode: null,
							backgrounded: false,
							cancelled: false,
							timedOut: true,
							sessionId,
						});
					}
				}, timeout);
			}
		});
		return {
			content: [
				{
					type: "text",
					text: appendWorktreeNotice(summarizeInteractiveResult(effectiveCommand!, result, timeout, effectiveReason), spawnWorktreePath),
				},
			],
			details: { ...result, spawnAgent, spawnMode, spawnWorktreePath },
		};
	};
	pi.registerShortcut(startupConfig.focusShortcut, {
		description: "Focus the latest kitty interactive shell session",
		handler: () => {
			const latest = sessionManager.list().at(-1);
			if (!latest?.session.focus) return;
			try {
				const maybePromise = latest.session.focus();
				if (maybePromise && typeof (maybePromise as Promise<unknown>).catch === "function") {
					(maybePromise as Promise<unknown>).catch((error: unknown) => {
						console.error("interactive-shell: focus shortcut failed:", error);
					});
				}
			} catch (error) {
				console.error("interactive-shell: focus shortcut failed:", error);
			}
		},
	});
	pi.registerShortcut(startupConfig.spawn.shortcut, {
		description: "Spawn the configured default agent in a managed kitty tab",
		handler: (ctx) => spawnKittySession(ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		coordinator.replaceBackgroundWidgetCleanup(setupBackgroundWidget(ctx, sessionManager, coordinator));
	});

	pi.on("session_shutdown", () => {
		coordinator.clearBackgroundWidget();
		sessionManager.killAll();
		coordinator.disposeAllMonitors();
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description: TOOL_DESCRIPTION,
		promptSnippet:
			"Use this only to delegate tasks to interactive CLI coding agents (pi/claude/cursor/gemini/codex/aider). Prefer mode='dispatch' for fire-and-forget delegations. When sending slash commands or prompts to an existing session, use submit=true so the text is actually submitted.",
		parameters: toolParameters,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const {
				command,
				spawn,
				sessionId,
				kill,
				outputLines,
				outputMaxChars,
				outputOffset,
				drain,
				incremental,
				settings,
				input,
				submit,
				inputKeys,
				inputHex,
				inputPaste,
				cwd,
				name,
				reason,
				mode,
				background,
				attach,
				listBackground,
				dismissBackground,
				monitorEvents,
				monitorStatus,
				monitorSessionId,
				monitorEventLimit,
				monitorEventOffset,
				monitorSinceEventId,
				monitorTriggerId,
				handsFree,
				handoffPreview,
				handoffSnapshot,
				timeout,
				monitor,
			} = params as ToolParams;

			const hasStructuredInput = inputKeys?.length || inputHex?.length || inputPaste;
			const effectiveInput = hasStructuredInput ? { text: input, keys: inputKeys, hex: inputHex, paste: inputPaste } : input;

			if (spawn && command) {
				return {
					content: [{ type: "text", text: "Use either 'command' or 'spawn', not both." }],
					isError: true,
				};
			}
			if (spawn && (sessionId || attach || listBackground || dismissBackground || monitorEvents || monitorStatus)) {
				return {
					content: [{ type: "text", text: "'spawn' is only valid when starting a new session." }],
					isError: true,
				};
			}

			if ((params as { monitorFilter?: unknown }).monitorFilter !== undefined) {
				return {
					content: [{ type: "text", text: "monitorFilter was removed. Use mode='monitor' with a structured monitor object." }],
					isError: true,
				};
			}

			if (monitorStatus) {
				const targetMonitorSessionId = monitorSessionId ?? sessionId;
				if (!targetMonitorSessionId) {
					return {
						content: [{ type: "text", text: "monitorStatus requires monitorSessionId (or sessionId)." }],
						isError: true,
					};
				}

				const state = coordinator.getMonitorSessionState(targetMonitorSessionId);
				if (!state) {
					return {
						content: [{ type: "text", text: `No monitor state for session ${targetMonitorSessionId}.` }],
						details: { sessionId: targetMonitorSessionId, state: null },
					};
				}

				const summary = [
					`Monitor state for ${targetMonitorSessionId}`,
					`Status: ${state.status}`,
					`Strategy: ${state.strategy}`,
					`Triggers: ${state.triggerIds.join(", ") || "(none)"}`,
					`Events: ${state.eventCount}`,
					`Started: ${state.startedAt}`,
					state.lastEventAt ? `Last event: #${state.lastEventId} at ${state.lastEventAt}` : "Last event: none",
					state.terminalReason ? `Terminal reason: ${state.terminalReason}` : "Terminal reason: (running)",
				].join("\n");

				return {
					content: [{ type: "text", text: summary }],
					details: { sessionId: targetMonitorSessionId, state },
				};
			}

			if (monitorEvents) {
				const targetMonitorSessionId = monitorSessionId ?? sessionId;
				if (!targetMonitorSessionId) {
					return {
						content: [{ type: "text", text: "monitorEvents requires monitorSessionId (or sessionId)." }],
						isError: true,
					};
				}

				const history = coordinator.getMonitorEvents(targetMonitorSessionId, {
					limit: monitorEventLimit,
					offset: monitorEventOffset,
					sinceEventId: monitorSinceEventId,
					triggerId: monitorTriggerId,
				});
				const state = coordinator.getMonitorSessionState(targetMonitorSessionId);
				if (history.total === 0) {
					return {
						content: [{ type: "text", text: `No monitor events for session ${targetMonitorSessionId}.` }],
						details: {
							sessionId: targetMonitorSessionId,
							events: [],
							total: 0,
							limit: history.limit,
							offset: history.offset,
							sinceEventId: history.sinceEventId,
							triggerId: history.triggerId,
							state,
						},
					};
				}

				const lines = history.events.map(
					(event) => `#${event.eventId} [${event.strategy}/${event.triggerId}] ${event.timestamp} :: ${event.matchedText}`,
				);
				return {
					content: [
						{
							type: "text",
							text: `Monitor events for ${targetMonitorSessionId} (${history.events.length}/${history.total}, offset ${history.offset}):\n${lines.join("\n")}`,
						},
					],
					details: {
						sessionId: targetMonitorSessionId,
						events: history.events,
						total: history.total,
						limit: history.limit,
						offset: history.offset,
						sinceEventId: history.sinceEventId,
						triggerId: history.triggerId,
						state,
					},
				};
			}

			// ── Branch 1: Interact with existing session ──
			if (sessionId) {
				const resolved = resolveSessionById(sessionId);
				const session = resolved.active;
				const bgSession = resolved.background;
				if (!session && !bgSession) {
					return {
						content: [{ type: "text", text: `Session not found or no longer active: ${sessionId}` }],
						isError: true,
						details: { sessionId, error: "session_not_found" },
					};
				}

				// Kill
				if (kill) {
					const killConfig = loadRuntimeConfig(ctx.cwd);
					const liveMonitor = coordinator.getMonitor(sessionId);

					if (session) {
						const alreadyCompleted = Boolean(session.getResult());
						if (!alreadyCompleted) {
							// Suppress the automatic completion turn; this tool call is the response.
							coordinator.markAgentHandledCompletion(sessionId);
						}
						const status = session.getStatus();
						const runtime = session.getRuntime();

						// Prefer the headless completion pipeline so storedResult / monitor state finalize.
						if (liveMonitor && !liveMonitor.disposed && !alreadyCompleted) {
							await new Promise<void>((resolve) => {
								let done = false;
								const finishWait = () => {
									if (done) return;
									done = true;
									resolve();
								};
								liveMonitor.registerCompleteCallback(finishWait);
								liveMonitor.cancel();
								// Bound wait: cancel kicks session.kill() which may take killGraceMs.
								const graceMs = Math.min(killConfig.kitty?.killGraceMs ?? 5000, 5000);
								setTimeout(finishWait, graceMs + 500);
							});
						} else {
							session.kill();
						}

						const { output, truncated, totalBytes, totalLines, hasMore } = await session.getOutput({
							skipRateLimit: true,
							lines: outputLines,
							maxChars: outputMaxChars,
							offset: outputOffset,
							drain,
							incremental,
						});
						const killHandoff =
							(await buildRegisteredHandoffArtifacts(sessionId, "kill")) ??
							(bgSession
								? await buildHandoffArtifacts(bgSession.session, "kill", killConfig, { command: session.command, cwd: ctx.cwd })
								: {});
						// Completion callbacks may already have unregistered; make cleanup idempotent.
						sessionManager.unregisterActive(sessionId, true);
						coordinator.disposeMonitor(sessionId);
						clearHandoffContext(sessionId);
						sessionManager.scheduleCleanup(sessionId, 5 * 60 * 1000);
						scheduleMonitorHistoryCleanup(sessionId);

						const { truncatedNote, hasMoreNote } = outputDisplayNotes(truncated, totalBytes, hasMore);
						return {
							content: [
								{
									type: "text",
									text: `Session ${sessionId} killed after ${formatDurationMs(runtime)}${output ? `\n\nFinal output${truncatedNote}${hasMoreNote}:\n${output}` : ""}`,
								},
							],
							details: {
								sessionId,
								status: "killed",
								runtime,
								output,
								outputTruncated: truncated,
								outputTotalBytes: totalBytes,
								outputTotalLines: totalLines,
								hasMore,
								previousStatus: status,
								...killHandoff,
							},
						};
					}

					// Background-only kill (active already unregistered after first result poll).
					const entry = bgSession!;
					const runtime = Date.now() - entry.startedAt.getTime();
					if (liveMonitor && !liveMonitor.disposed) {
						await new Promise<void>((resolve) => {
							let done = false;
							const finishWait = () => {
								if (done) return;
								done = true;
								resolve();
							};
							liveMonitor.registerCompleteCallback(finishWait);
							liveMonitor.cancel();
							const graceMs = Math.min(killConfig.kitty?.killGraceMs ?? 5000, 5000);
							setTimeout(finishWait, graceMs + 500);
						});
					} else if (!entry.session.exited) {
						entry.session.kill();
					}
					const queried = await queryBackgroundSessionOutput(sessionId, entry, ctx.cwd, {
						outputLines,
						outputMaxChars,
						outputOffset,
						drain,
						incremental,
						skipRateLimit: true,
					});
					const killHandoff =
						(await buildRegisteredHandoffArtifacts(sessionId, "kill")) ??
						(await buildHandoffArtifacts(entry.session, "kill", killConfig, { command: entry.command, cwd: ctx.cwd }));
					sessionManager.unregisterActive(sessionId, true);
					coordinator.disposeMonitor(sessionId);
					clearHandoffContext(sessionId);
					sessionManager.scheduleCleanup(sessionId, 5 * 60 * 1000);
					scheduleMonitorHistoryCleanup(sessionId);
					const { truncatedNote, hasMoreNote } = outputDisplayNotes(queried.truncated, queried.totalBytes, queried.hasMore);
					return {
						content: [
							{
								type: "text",
								text: `Session ${sessionId} killed after ${formatDurationMs(runtime)}${queried.output ? `\n\nFinal output${truncatedNote}${hasMoreNote}:\n${queried.output}` : ""}`,
							},
						],
						details: {
							sessionId,
							status: "killed",
							runtime,
							output: queried.output,
							outputTruncated: queried.truncated,
							outputTotalBytes: queried.totalBytes,
							outputTotalLines: queried.totalLines,
							hasMore: queried.hasMore,
							previousStatus: queried.status,
							...killHandoff,
						},
					};
				}

				// Background
				if (background) {
					if (!session) {
						// Already background-managed (or completed after active unregister).
						return {
							content: [
								{
									type: "text",
									text: `Session ${sessionId} is already managed in kitty; use attach/focus to watch it. Background is a no-op for kitty sessions.`,
								},
							],
							details: { sessionId, alreadyManaged: true },
						};
					}
					if (session.getResult()) {
						return {
							content: [{ type: "text", text: "Session already completed." }],
							details: session.getResult(),
						};
					}
					const bMonitor = coordinator.getMonitor(sessionId);
					if (!bMonitor || bMonitor.disposed) {
						coordinator.markAgentHandledCompletion(sessionId);
					}
					session.background();
					const result = session.getResult();
					if (!result || !result.backgrounded) {
						coordinator.consumeAgentHandledCompletion(sessionId);
						// Kitty sessions are already detached managed tabs — background is a no-op.
						return {
							content: [
								{
									type: "text",
									text: `Session ${sessionId} is already managed in kitty; use attach/focus to watch it. Background is a no-op for kitty sessions.`,
								},
							],
							details: { sessionId, alreadyManaged: true },
						};
					}
					sessionManager.unregisterActive(sessionId, false);
					return {
						content: [{ type: "text", text: `Session backgrounded (id: ${result.backgroundId})` }],
						details: { sessionId, backgroundId: result.backgroundId, ...result },
					};
				}

				const actions: string[] = [];

				if (settings?.updateInterval !== undefined) {
					if (sessionManager.setActiveUpdateInterval(sessionId, settings.updateInterval)) {
						actions.push(`update interval set to ${settings.updateInterval}ms`);
					} else if (!session) {
						return {
							content: [
								{ type: "text", text: `Cannot change settings on session ${sessionId}: no longer active (query via sessionId or attach).` },
							],
							isError: true,
							details: { sessionId, error: "settings_not_active" },
						};
					}
				}
				if (settings?.quietThreshold !== undefined) {
					if (sessionManager.setActiveQuietThreshold(sessionId, settings.quietThreshold)) {
						actions.push(`quiet threshold set to ${settings.quietThreshold}ms`);
					} else if (!session && settings?.updateInterval === undefined) {
						return {
							content: [
								{ type: "text", text: `Cannot change settings on session ${sessionId}: no longer active (query via sessionId or attach).` },
							],
							isError: true,
							details: { sessionId, error: "settings_not_active" },
						};
					}
				}

				if (effectiveInput !== undefined || submit) {
					if (session) {
						const success = await sendStructuredInput(session, sessionId, effectiveInput, submit);
						if (!success) {
							return {
								content: [{ type: "text", text: `Failed to send input to session: ${sessionId}` }],
								isError: true,
								details: { sessionId, error: "write_failed" },
							};
						}
					} else if (bgSession && !bgSession.session.exited) {
						// Active unregistered but kitty tab still running — send via terminal bindings.
						const success = await sendStructuredInput(
							{ ...sessionIoBindings(bgSession.session), id: sessionId } as ActiveSession,
							sessionId,
							effectiveInput,
							submit,
						);
						if (!success) {
							return {
								content: [{ type: "text", text: `Failed to send input to session: ${sessionId}` }],
								isError: true,
								details: { sessionId, error: "write_failed" },
							};
						}
					} else {
						return {
							content: [{ type: "text", text: `Cannot send input to session ${sessionId}: session is no longer active.` }],
							isError: true,
							details: { sessionId, error: "input_not_active" },
						};
					}
					const inputDesc = describeInputPayload(effectiveInput);
					if (submit) {
						actions.push(inputDesc ? `sent: ${inputDesc} + enter` : "sent: enter");
					} else {
						actions.push(`sent: ${inputDesc}`);
					}
				}

				if (actions.length === 0) {
					// Background-only query path (after first completed poll unregistered active).
					if (!session && bgSession) {
						return getBackgroundOutputResponse(sessionId, bgSession, ctx.cwd, {
							outputLines,
							outputMaxChars,
							outputOffset,
							drain,
							incremental,
						});
					}

					const activeSession = session!;
					const status = activeSession.getStatus();
					const runtime = activeSession.getRuntime();
					const result = activeSession.getResult();

					if (result) {
						const outputResult = await activeSession.getOutput({
							skipRateLimit: true,
							lines: outputLines,
							maxChars: outputMaxChars,
							offset: outputOffset,
							drain,
							incremental,
						});
						// Keep completion on the background entry, then drop active so further
						// sessionId queries use the background fallback (with full lastResult).
						persistBackgroundResult(sessionId, result);
						sessionManager.unregisterActive(sessionId, result.backgrounded === false);
						return buildCompletedSessionResponse(sessionId, status, runtime, outputResult, result);
					}

					const outputResult = await activeSession.getOutput({
						lines: outputLines,
						maxChars: outputMaxChars,
						offset: outputOffset,
						drain,
						incremental,
					});

					if (outputResult.rateLimited && outputResult.waitSeconds) {
						const waitMs = outputResult.waitSeconds * 1000;
						const completedEarly = await Promise.race([
							new Promise<false>((resolve) => setTimeout(() => resolve(false), waitMs)),
							new Promise<true>((resolve) => activeSession.onComplete(() => resolve(true))),
						]);

						if (completedEarly) {
							const earlySession = sessionManager.getActive(sessionId);
							if (!earlySession) {
								// Completion may have raced unregister; fall back to background if present.
								const fallbackBg = sessionManager.hasBackground(sessionId) ? sessionManager.get(sessionId) : undefined;
								if (fallbackBg) {
									return getBackgroundOutputResponse(sessionId, fallbackBg, ctx.cwd, {
										outputLines,
										outputMaxChars,
										outputOffset,
										drain,
										incremental,
									});
								}
								return { content: [{ type: "text", text: `Session ${sessionId} ended` }], details: { sessionId, status: "ended" } };
							}
							const earlyResult = earlySession.getResult();
							const { output, truncated, totalBytes, totalLines, hasMore } = await earlySession.getOutput({
								skipRateLimit: true,
								lines: outputLines,
								maxChars: outputMaxChars,
								offset: outputOffset,
								drain,
								incremental,
							});
							const earlyStatus = earlySession.getStatus();
							const earlyRuntime = earlySession.getRuntime();
							const { truncatedNote, hasMoreNote } = outputDisplayNotes(truncated, totalBytes, hasMore);
							if (earlyResult) {
								persistBackgroundResult(sessionId, earlyResult);
								sessionManager.unregisterActive(sessionId, earlyResult.backgrounded === false);
								return buildCompletedSessionResponse(
									sessionId,
									earlyStatus,
									earlyRuntime,
									{ output, truncated, totalBytes, totalLines, hasMore },
									earlyResult,
								);
							}
							return {
								content: [
									{
										type: "text",
										text: `Session ${sessionId} ${earlyStatus} (${formatDurationMs(earlyRuntime)})${output ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${output}` : ""}`,
									},
								],
								details: {
									sessionId,
									status: earlyStatus,
									runtime: earlyRuntime,
									output,
									outputTruncated: truncated,
									outputTotalBytes: totalBytes,
									outputTotalLines: totalLines,
									hasMore,
									hasOutput: output.length > 0,
								},
							};
						}

						const freshOutput = await activeSession.getOutput({
							lines: outputLines,
							maxChars: outputMaxChars,
							offset: outputOffset,
							drain,
							incremental,
						});
						const { truncatedNote, hasMoreNote } = outputDisplayNotes(freshOutput.truncated, freshOutput.totalBytes, freshOutput.hasMore);
						const freshStatus = activeSession.getStatus();
						const freshRuntime = activeSession.getRuntime();
						const freshResult = activeSession.getResult();
						if (freshResult) {
							persistBackgroundResult(sessionId, freshResult);
							sessionManager.unregisterActive(sessionId, freshResult.backgrounded === false);
							return buildCompletedSessionResponse(
								sessionId,
								freshStatus,
								freshRuntime,
								{
									output: freshOutput.output,
									truncated: freshOutput.truncated,
									totalBytes: freshOutput.totalBytes,
									totalLines: freshOutput.totalLines,
									hasMore: freshOutput.hasMore,
								},
								freshResult,
							);
						}
						return {
							content: [
								{
									type: "text",
									text: `Session ${sessionId} ${freshStatus} (${formatDurationMs(freshRuntime)})${freshOutput.output ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${freshOutput.output}` : ""}`,
								},
							],
							details: {
								sessionId,
								status: freshStatus,
								runtime: freshRuntime,
								output: freshOutput.output,
								outputTruncated: freshOutput.truncated,
								outputTotalBytes: freshOutput.totalBytes,
								outputTotalLines: freshOutput.totalLines,
								hasMore: freshOutput.hasMore,
								hasOutput: freshOutput.output.length > 0,
							},
						};
					}

					const { output, truncated, totalBytes, totalLines, hasMore } = outputResult;
					const { truncatedNote, hasMoreNote } = outputDisplayNotes(truncated, totalBytes, hasMore);
					return {
						content: [
							{
								type: "text",
								text: `Session ${sessionId} ${status} (${formatDurationMs(runtime)})${output ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${output}` : ""}`,
							},
						],
						details: {
							sessionId,
							status,
							runtime,
							output,
							outputTruncated: truncated,
							outputTotalBytes: totalBytes,
							outputTotalLines: totalLines,
							hasMore,
							hasOutput: output.length > 0,
						},
					};
				}

				return {
					content: [{ type: "text", text: `Session ${sessionId}: ${actions.join(", ")}` }],
					details: { sessionId, actions },
				};
			}

			// ── Branch 2: Attach to background session ──
			if (attach) {
				if (background) {
					return {
						content: [{ type: "text", text: "Cannot attach and background simultaneously." }],
						isError: true,
					};
				}

				const monitor = coordinator.getMonitor(attach);
				const bgSession = sessionManager.get(attach);
				if (!bgSession) {
					disposeStaleMonitor(attach, monitor);
					return {
						content: [{ type: "text", text: `Background session not found: ${attach}` }],
						isError: true,
					};
				}

				const config = loadRuntimeConfig(cwd ?? ctx.cwd);
				try {
					await bgSession.session.focus?.();
				} catch (error) {
					if (!monitor || monitor.disposed) {
						sessionManager.restartAutoCleanup(attach);
					}
					return {
						content: [
							{ type: "text", text: `Failed to focus kitty session ${attach}: ${error instanceof Error ? error.message : String(error)}` },
						],
						isError: true,
					};
				}

				// Reuse manager-owned query state — do not createSessionQueryState() here.
				// A fresh state resets the incremental cursor so attach pagination restarts at 0.
				const queryState = sessionManager.getQueryState(attach);
				const { output, truncated, totalBytes, totalLines, hasMore } = await getSessionOutput(
					bgSession.session,
					config,
					queryState,
					{
						skipRateLimit: true,
						lines: outputLines,
						maxChars: outputMaxChars,
						offset: outputOffset,
						drain,
						incremental,
					},
					bgSession.lastResult?.completionOutput,
				);
				// Re-register active while the tab is still running so settings/input via
				// sessionId work after attach (main reattach re-opened an overlay handle).
				if (!bgSession.session.exited) {
					rehydrateActiveFromBackground(attach, config);
				}
				if (!monitor || monitor.disposed) {
					sessionManager.restartAutoCleanup(attach);
				}
				const status = statusFromBackground(bgSession);
				const { truncatedNote, hasMoreNote } = outputDisplayNotes(truncated, totalBytes, hasMore);
				const runtime = Date.now() - bgSession.startedAt.getTime();
				const outputBlock = { output, truncated, totalBytes, totalLines, hasMore };
				if (bgSession.lastResult) {
					return {
						content: [
							{
								type: "text",
								text: `Focused kitty session ${attach} (${status})${output ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${output}` : ""}`,
							},
						],
						details: {
							...completedSessionQueryDetails(attach, status, runtime, outputBlock, bgSession.lastResult),
							focused: true,
						},
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `Focused kitty session ${attach} (${status})${output ? `\n\nOutput${truncatedNote}${hasMoreNote}:\n${output}` : ""}`,
						},
					],
					details: {
						sessionId: attach,
						status,
						runtime,
						output,
						outputTruncated: truncated,
						outputTotalBytes: totalBytes,
						outputTotalLines: totalLines,
						hasMore,
						focused: true,
					},
				};
			}

			// ── Branch 3: List background sessions ──
			if (listBackground) {
				const sessions = sessionManager.list();
				if (sessions.length === 0) {
					return { content: [{ type: "text", text: "No background sessions." }] };
				}
				const lines = sessions.map((s) => {
					const monitorState = coordinator.getMonitorSessionState(s.id);
					const status = s.session.exited ? "exited" : "running";
					const duration = formatDuration(Date.now() - s.startedAt.getTime());
					const r = s.reason ? ` \u2022 ${s.reason}` : "";
					const monitorLabel = monitorState
						? ` \u2022 monitor:${monitorState.strategy} events=${monitorState.eventCount}${monitorState.lastEventAt ? ` last=${monitorState.lastEventAt}` : ""}`
						: "";
					return `  ${s.id} - ${s.command}${r}${monitorLabel} (${status}, ${duration})`;
				});
				return { content: [{ type: "text", text: `Background sessions:\n${lines.join("\n")}` }] };
			}

			// ── Branch 3b: Dismiss background sessions ──
			if (dismissBackground) {
				if (typeof dismissBackground === "string") {
					if (!sessionManager.list().some((s) => s.id === dismissBackground)) {
						return { content: [{ type: "text", text: `Background session not found: ${dismissBackground}` }], isError: true };
					}
				}

				const targetIds = typeof dismissBackground === "string" ? [dismissBackground] : sessionManager.list().map((s) => s.id);

				if (targetIds.length === 0) {
					return { content: [{ type: "text", text: "No background sessions to dismiss." }] };
				}

				for (const tid of targetIds) {
					coordinator.disposeMonitor(tid);
					coordinator.clearMonitorEvents(tid);
					sessionManager.unregisterActive(tid, false);
					clearHandoffContext(tid);
					sessionManager.remove(tid);
				}

				const summary =
					targetIds.length === 1
						? `Dismissed session ${targetIds[0]}.`
						: `Dismissed ${targetIds.length} sessions: ${targetIds.join(", ")}.`;
				return { content: [{ type: "text", text: summary }] };
			}

			// ── Branch 4: Start new session ──
			const allowsGeneratedCommand = mode === "monitor" && monitor?.strategy === "file-watch";
			if (!command && !spawn && !allowsGeneratedCommand) {
				return {
					content: [
						{
							type: "text",
							text: "One of 'command', 'spawn', 'sessionId', 'attach', 'listBackground', or 'dismissBackground' is required.",
						},
					],
					isError: true,
				};
			}
			return startNewSession({
				ctx,
				command,
				spawn,
				cwd,
				name,
				reason,
				mode,
				background,
				monitor,
				handsFree,
				handoffPreview,
				handoffSnapshot,
				timeout,
				signal,
				onUpdate,
				input,
				inputKeys,
				inputHex,
				inputPaste,
				submit,
			});
		},
	});

	pi.registerCommand("spawn", {
		description: "Spawn the configured default agent, pi, codex, claude, or cursor in a managed kitty tab",
		handler: async (args, ctx) => {
			const parsed = parseSpawnArgs(args);
			if (!parsed.ok) {
				ctx.ui.notify(
					`${parsed.error}\nUsage: /spawn [pi|codex|claude|cursor] [fresh|fork] [--worktree] [\"prompt\" --hands-free|--dispatch]`,
					"error",
				);
				return;
			}
			if (parsed.parsed.monitorMode) {
				const result = await startNewSession({
					ctx,
					spawn: parsed.parsed.request,
					mode: parsed.parsed.monitorMode,
				});
				if (result.isError) {
					ctx.ui.notify(result.content[0]?.text ?? "Failed to start session.", "error");
				}
				return;
			}
			await spawnKittySession(ctx, parsed.parsed.request);
		},
	});

	pi.registerCommand("attach", {
		description: "Focus a background kitty shell session",
		handler: async (args, ctx) => {
			const sessions = sessionManager.list();
			if (sessions.length === 0) {
				ctx.ui.notify("No background sessions", "info");
				return;
			}

			let targetId = args.trim();
			if (!targetId) {
				const options = sessions.map((s) => {
					const status = s.session.exited ? "exited" : "running";
					const duration = formatDuration(Date.now() - s.startedAt.getTime());
					const sanitizedCommand = s.command.replace(/\s+/g, " ").trim();
					const sanitizedReason = s.reason?.replace(/\s+/g, " ").trim();
					const r = sanitizedReason ? ` \u2022 ${sanitizedReason}` : "";
					return {
						id: s.id,
						label: `${s.id} - ${sanitizedCommand}${r} (${status}, ${duration})`,
					};
				});
				const choice = await ctx.ui.select(
					"Background Sessions",
					options.map((o) => o.label),
				);
				if (!choice) return;
				targetId = options.find((o) => o.label === choice)!.id;
			}

			const monitor = coordinator.getMonitor(targetId);
			const session = sessionManager.get(targetId);
			if (!session) {
				disposeStaleMonitor(targetId, monitor);
				ctx.ui.notify(`Session not found: ${targetId}`, "error");
				return;
			}

			try {
				await session.session.focus?.();
			} catch (error) {
				if (!monitor || monitor.disposed) {
					sessionManager.restartAutoCleanup(targetId);
				}
				ctx.ui.notify(`Failed to focus session ${targetId}: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			if (!monitor || monitor.disposed) {
				sessionManager.restartAutoCleanup(targetId);
			}
			ctx.ui.notify(`Focused session ${targetId}`, "info");
		},
	});

	pi.registerCommand("dismiss", {
		description: "Dismiss background shell sessions (kill running, remove exited)",
		handler: async (args, ctx) => {
			const sessions = sessionManager.list();
			if (sessions.length === 0) {
				ctx.ui.notify("No background sessions", "info");
				return;
			}

			let targetIds: string[];
			const arg = args.trim();
			if (arg) {
				if (!sessions.some((s) => s.id === arg)) {
					ctx.ui.notify(`Session not found: ${arg}`, "error");
					return;
				}
				targetIds = [arg];
			} else if (sessions.length === 1) {
				targetIds = [sessions[0].id];
			} else {
				const options = [
					{ label: "All sessions" },
					...sessions.map((s) => {
						const status = s.session.exited ? "exited" : "running";
						const duration = formatDuration(Date.now() - s.startedAt.getTime());
						return { id: s.id, label: `${s.id} (${status}, ${duration})` };
					}),
				];
				const choice = await ctx.ui.select(
					"Dismiss sessions",
					options.map((o) => o.label),
				);
				if (!choice) return;
				const selected = options.find((o) => o.label === choice);
				targetIds = selected?.id ? [selected.id] : sessions.map((s) => s.id);
			}

			for (const tid of targetIds) {
				coordinator.disposeMonitor(tid);
				coordinator.clearMonitorEvents(tid);
				sessionManager.unregisterActive(tid, false);
				clearHandoffContext(tid);
				sessionManager.remove(tid);
			}

			const noun = targetIds.length === 1 ? "session" : "sessions";
			ctx.ui.notify(`Dismissed ${targetIds.length} ${noun}`, "info");
		},
	});
}
