/**
 * Compute stream delta between two kitty get-text snapshots.
 * Avoids re-appending the full snapshot when scrollback truncates or the TUI redraws.
 * Returns empty delta with rewrite=true when the change is a non-append rewrite
 * (caller should update the authoritative snapshot only, not stream listeners).
 */
export function computeSnapshotDelta(previous: string, next: string): { delta: string; rewrite: boolean } {
	if (next === previous) return { delta: "", rewrite: false };
	// Blank screen (extent:all padding only) must be treated as empty: otherwise
	// "all blanks -> first real output" is classified as a full rewrite and the
	// first content never lands in the append-only drain/rawOutput stream.
	if (!previous || isBlankSnapshot(previous)) return { delta: next, rewrite: false };
	if (next.startsWith(previous)) return { delta: next.slice(previous.length), rewrite: false };

	// Compare logical lines so one-line roll-off works whether or not the snapshots
	// share trailing-newline shape (e.g. "line1\nline2" -> "line2\nline3").
	// logicalLines trims trailing blank padding — without that, appends like
	// "v1" -> "v1\nv2" look like non-overlapping rewrites and drop v2 from the stream.
	const previousLines = logicalLines(previous);
	const nextLines = logicalLines(next);
	const maxOverlapLines = Math.min(previousLines.length, nextLines.length);
	for (let lineCount = maxOverlapLines; lineCount > 0; lineCount--) {
		const previousSuffix = previousLines.slice(previousLines.length - lineCount);
		const nextPrefix = nextLines.slice(0, lineCount);
		if (!arraysEqual(previousSuffix, nextPrefix) || !isUsefulLogicalOverlap(nextPrefix, lineCount)) {
			continue;
		}
		const remaining = nextLines.slice(lineCount);
		if (remaining.length === 0) return { delta: "", rewrite: false };
		let delta = remaining.join("\n");
		if (/[\r\n]$/.test(next)) delta += "\n";
		// Keep a line boundary when the previous snapshot did not end with a newline.
		if (!/[\r\n]$/.test(previous) && !delta.startsWith("\n")) {
			delta = `\n${delta}`;
		}
		return { delta, rewrite: false };
	}

	// Full rewrite / TUI screen replace — do not stream-append the entire snapshot.
	return { delta: "", rewrite: true };
}

/**
 * Lines that changed (or appeared) between two snapshots — used so stream monitors
 * still see in-place TUI updates without re-appending the full screen to rawOutput.
 */
export function computeRewriteMonitorPayload(previous: string, next: string): string {
	const previousLines = logicalLines(previous);
	const nextLines = logicalLines(next);
	const changed: string[] = [];
	for (let i = 0; i < nextLines.length; i++) {
		if (previousLines[i] !== nextLines[i]) {
			changed.push(nextLines[i]!);
		}
	}
	if (changed.length === 0) return "";
	return `${changed.join("\n")}\n`;
}

export function logicalLines(value: string): string[] {
	const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalized.split("\n");
	// Drop trailing blank screen-padding rows (kitty get-text extent:all pads below
	// the cursor with empty rows). Keep internal blanks. Required so overlap/diff
	// compares real content rather than ~rows of padding.
	while (lines.length > 0 && lines[lines.length - 1]!.trim().length === 0) {
		lines.pop();
	}
	return lines;
}

/** True when a snapshot is only blank/padding rows (no real content yet). */
function isBlankSnapshot(value: string): boolean {
	return value.split("\n").every((line) => line.trim().length === 0);
}

function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function isUsefulLogicalOverlap(overlap: string[], lineCount: number): boolean {
	if (lineCount >= 2) return true;
	// A one-line overlap is useful for small scrollbacks, but a lone empty/whitespace
	// boundary is too weak and commonly appears during TUI rewrites.
	return (overlap[0] ?? "").trim().length > 0;
}
