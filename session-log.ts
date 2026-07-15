import { stripVTControlCharacters } from "node:util";

export const MAX_RAW_OUTPUT_SIZE = 1024 * 1024;

export function trimRawOutput(rawOutput: string, lastStreamPosition: number): { rawOutput: string; lastStreamPosition: number } {
	if (rawOutput.length <= MAX_RAW_OUTPUT_SIZE) {
		return { rawOutput, lastStreamPosition };
	}
	const keepSize = Math.floor(MAX_RAW_OUTPUT_SIZE / 2);
	const trimAmount = rawOutput.length - keepSize;
	return {
		rawOutput: rawOutput.substring(trimAmount),
		lastStreamPosition: Math.max(0, lastStreamPosition - trimAmount),
	};
}

export function sliceLogOutput(
	text: string,
	options: { offset?: number; limit?: number; stripAnsi?: boolean } = {},
): {
	slice: string;
	totalLines: number;
	totalChars: number;
	sliceLineCount: number;
} {
	let source = text;
	if (options.stripAnsi !== false && source) {
		source = stripVTControlCharacters(source);
	}
	if (!source) {
		return { slice: "", totalLines: 0, totalChars: 0, sliceLineCount: 0 };
	}

	const normalized = source.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	// Pitfall: kitty get-text extent:all returns a fixed-size buffer padded with empty
	// rows below the cursor. Without trimming, "last N lines" / log slices for short
	// commands are all blanks. Drop only *trailing* blank padding; keep internal blanks.
	while (lines.length > 0 && lines[lines.length - 1]!.trim().length === 0) {
		lines.pop();
	}

	const totalLines = lines.length;
	const totalChars = source.length;
	let start: number;
	if (typeof options.offset === "number" && Number.isFinite(options.offset)) {
		start = Math.max(0, Math.floor(options.offset));
	} else if (options.limit !== undefined) {
		const tailCount = Math.max(0, Math.floor(options.limit));
		start = Math.max(totalLines - tailCount, 0);
	} else {
		start = 0;
	}

	const end =
		typeof options.limit === "number" && Number.isFinite(options.limit) ? start + Math.max(0, Math.floor(options.limit)) : undefined;
	const selectedLines = lines.slice(start, end);
	return {
		slice: selectedLines.join("\n"),
		totalLines,
		totalChars,
		sliceLineCount: selectedLines.length,
	};
}

/**
 * Cap a list of lines so `lines.join("\n").length <= maxChars`.
 * Oversized single lines are sliced; omitted content sets truncatedByChars.
 */
export function capLinesByMaxChars(lines: string[], maxChars: number): { lines: string[]; truncatedByChars: boolean } {
	if (maxChars <= 0) return { lines: [], truncatedByChars: lines.length > 0 };
	const out: string[] = [];
	let used = 0;
	for (const line of lines) {
		const separator = out.length > 0 ? 1 : 0; // "\n" between lines
		if (used + separator >= maxChars) {
			return { lines: out, truncatedByChars: true };
		}
		const budget = maxChars - used - separator;
		if (line.length > budget) {
			const piece = line.slice(0, budget);
			if (piece.length > 0) out.push(piece);
			return { lines: out, truncatedByChars: true };
		}
		used += separator + line.length;
		out.push(line);
	}
	return { lines: out, truncatedByChars: false };
}
