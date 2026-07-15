import type { InteractiveShellConfig } from "./config.js";
import type { OutputOptions, OutputResult } from "./session-manager.js";
import type { InteractiveShellResult } from "./types.js";
import type { TerminalSession } from "./terminal-session.js";

/** Mutable query bookkeeping kept per active session. */
export interface SessionQueryState {
	lastQueryTime: number;
	/** Line index of the next unread logical line. */
	incrementalReadPosition: number;
	/**
	 * Character offset within the line at `incrementalReadPosition` when the previous
	 * page truncated mid-line due to maxChars. 0 means the next page starts at line start.
	 */
	incrementalCharOffset: number;
}

export const DEFAULT_STATUS_OUTPUT = 5 * 1024;
export const DEFAULT_STATUS_LINES = 20;
export const MAX_STATUS_OUTPUT = 50 * 1024;
export const MAX_STATUS_LINES = 200;

export function createSessionQueryState(): SessionQueryState {
	return {
		lastQueryTime: 0,
		incrementalReadPosition: 0,
		incrementalCharOffset: 0,
	};
}

export async function getSessionOutput(
	session: TerminalSession,
	config: InteractiveShellConfig,
	state: SessionQueryState,
	options: OutputOptions | boolean = false,
	completionOutput?: InteractiveShellResult["completionOutput"],
): Promise<OutputResult> {
	// Pitfall: completionOutput is a fixed exit-time snapshot. If it short-circuits
	// *before* incremental/drain/offset, paginated reads on finished sessions always
	// return the full snapshot and never advance the cursor. Honour those explicit
	// modes against the live session first (getLogSlice / getRawStream fall back to
	// lastKittyText after exit); only the default tail uses completionOutput.
	const opts = typeof options === "boolean" ? { skipRateLimit: options } : options;
	const requestedLines = clampPositive(opts.lines ?? DEFAULT_STATUS_LINES, MAX_STATUS_LINES);
	const requestedMaxChars = clampPositive(opts.maxChars ?? DEFAULT_STATUS_OUTPUT, MAX_STATUS_OUTPUT);
	const rateLimited = maybeRateLimitQuery(config, state, opts.skipRateLimit ?? false);
	if (rateLimited) return rateLimited;
	if (opts.incremental) {
		return getIncrementalOutput(session, state, requestedLines, requestedMaxChars);
	}

	if (opts.drain) {
		// Drain is the local append-only stream (poll deltas), not a live get-text.
		return buildTruncatedOutput(session.getRawStream({ sinceLast: true, stripAnsi: true }), requestedMaxChars, true);
	}

	if (completionOutput && opts.offset === undefined) {
		return buildCompletionOutputResult(completionOutput);
	}

	if (opts.offset !== undefined) {
		return getOffsetOutput(session, opts.offset, requestedLines, requestedMaxChars);
	}

	const tailResult = await session.getTailLines({
		lines: requestedLines,
		ansi: false,
		maxChars: requestedMaxChars,
	});
	const output = tailResult.lines.join("\n");
	return {
		output,
		truncated: tailResult.lines.length < tailResult.totalLinesInBuffer || tailResult.truncatedByChars,
		totalBytes: output.length,
		totalLines: tailResult.totalLinesInBuffer,
	};
}

function maybeRateLimitQuery(config: InteractiveShellConfig, state: SessionQueryState, skipRateLimit: boolean): OutputResult | null {
	if (skipRateLimit) return null;
	const now = Date.now();
	const minIntervalMs = config.minQueryIntervalSeconds * 1000;
	const elapsed = now - state.lastQueryTime;
	if (state.lastQueryTime > 0 && elapsed < minIntervalMs) {
		return {
			output: "",
			truncated: false,
			totalBytes: 0,
			rateLimited: true,
			waitSeconds: Math.ceil((minIntervalMs - elapsed) / 1000),
		};
	}
	state.lastQueryTime = now;
	return null;
}

async function getIncrementalOutput(
	session: TerminalSession,
	state: SessionQueryState,
	requestedLines: number,
	requestedMaxChars: number,
): Promise<OutputResult> {
	// Fetch from the current line; if we previously truncated mid-line, start that
	// line at incrementalCharOffset so truncated content is not skipped forever.
	const result = await session.getLogSlice({
		offset: state.incrementalReadPosition,
		limit: requestedLines,
		stripAnsi: true,
	});
	const rawLines = result.slice.length > 0 ? result.slice.split("\n") : [];
	const startLine = state.incrementalReadPosition;
	const startChar = state.incrementalCharOffset;
	const lines = rawLines.map((line, index) => (index === 0 && startChar > 0 ? line.slice(startChar) : line));

	const page = takeIncrementalPage(lines, requestedMaxChars);
	if (page.linesConsumed === 0) {
		return {
			output: "",
			truncated: page.truncated,
			totalBytes: 0,
			totalLines: result.totalLines,
			hasMore: startLine < result.totalLines,
		};
	}

	if (page.partialChars > 0) {
		// Stopped mid-line: stay on that line, advance the character cursor.
		const lineIndex = startLine + page.linesConsumed - 1;
		const charOffset = (page.linesConsumed === 1 ? startChar : 0) + page.partialChars;
		state.incrementalReadPosition = lineIndex;
		state.incrementalCharOffset = charOffset;
	} else {
		state.incrementalReadPosition = startLine + page.linesConsumed;
		state.incrementalCharOffset = 0;
	}

	const hasMore = state.incrementalReadPosition < result.totalLines || state.incrementalCharOffset > 0;

	return {
		output: page.text,
		truncated: page.truncated || hasMore,
		totalBytes: page.text.length,
		totalLines: result.totalLines,
		hasMore,
	};
}

/**
 * Take a maxChars-limited page from logical lines.
 * `partialChars` is how many characters of the last consumed line were returned
 * when that line was truncated mid-way (0 when the last consumed line finished).
 */
export function takeIncrementalPage(
	lines: string[],
	maxChars: number,
): { text: string; linesConsumed: number; partialChars: number; truncated: boolean } {
	if (maxChars <= 0 || lines.length === 0) {
		return { text: "", linesConsumed: 0, partialChars: 0, truncated: lines.length > 0 };
	}
	const out: string[] = [];
	let used = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const separator = out.length > 0 ? 1 : 0;
		if (used + separator >= maxChars) {
			return { text: out.join("\n"), linesConsumed: i, partialChars: 0, truncated: true };
		}
		const budget = maxChars - used - separator;
		if (line.length > budget) {
			const piece = line.slice(0, budget);
			if (piece.length > 0) {
				out.push(piece);
				return {
					text: out.join("\n"),
					linesConsumed: i + 1,
					partialChars: piece.length,
					truncated: true,
				};
			}
			return { text: out.join("\n"), linesConsumed: i, partialChars: 0, truncated: true };
		}
		used += separator + line.length;
		out.push(line);
	}
	return { text: out.join("\n"), linesConsumed: lines.length, partialChars: 0, truncated: false };
}

async function getOffsetOutput(
	session: TerminalSession,
	offset: number,
	requestedLines: number,
	requestedMaxChars: number,
): Promise<OutputResult> {
	const result = await session.getLogSlice({
		offset,
		limit: requestedLines,
		stripAnsi: true,
	});
	const output = truncateForMaxChars(result.slice, requestedMaxChars);
	const hasMore = offset + result.sliceLineCount < result.totalLines;
	return {
		output: output.value,
		truncated: output.truncated || hasMore,
		totalBytes: output.value.length,
		totalLines: result.totalLines,
		hasMore,
	};
}

function buildCompletionOutputResult(completionOutput: NonNullable<InteractiveShellResult["completionOutput"]>): OutputResult {
	const output = completionOutput.lines.join("\n");
	return {
		output,
		truncated: completionOutput.truncated,
		totalBytes: output.length,
		totalLines: completionOutput.totalLines,
	};
}

function buildTruncatedOutput(output: string, requestedMaxChars: number, sliceFromEnd = false): OutputResult {
	const truncated = output.length > requestedMaxChars;
	let value = output;
	if (truncated) {
		value = sliceFromEnd ? output.slice(-requestedMaxChars) : output.slice(0, requestedMaxChars);
	}
	return {
		output: value,
		truncated,
		totalBytes: value.length,
	};
}

function truncateForMaxChars(output: string, requestedMaxChars: number): { value: string; truncated: boolean } {
	if (output.length <= requestedMaxChars) {
		return { value: output, truncated: false };
	}
	return {
		value: output.slice(0, requestedMaxChars),
		truncated: true,
	};
}

function clampPositive(value: number, max: number): number {
	return Math.max(1, Math.min(max, value));
}
