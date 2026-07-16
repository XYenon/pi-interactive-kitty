import { accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

/**
 * Resolve a real Node.js binary suitable for spawning `runner.mjs` / `node -e …`.
 *
 * Pitfall: when this extension is loaded by pi, `process.execPath` is the pi SEA
 * (Single Executable Application) binary — not plain `node`. Spawning
 * `[process.execPath, runner.mjs]` becomes `pi runner.mjs`, which starts the pi
 * TUI instead of executing the runner. Same for `pi -e` (unsupported; args are
 * treated as extension paths).
 *
 * Override with env `PI_INTERACTIVE_NODE` or `NODE_BINARY` when needed.
 */
export function resolveNodeExecutable(): string {
	const override = firstNonEmpty(process.env.PI_INTERACTIVE_NODE, process.env.NODE_BINARY);
	if (override) {
		assertExecutable(override);
		return override;
	}

	if (isPlainNodeBinary(process.execPath)) {
		return process.execPath;
	}

	const fromNpm = firstNonEmpty(process.env.npm_node_execpath);
	if (fromNpm && isPlainNodeBinary(fromNpm)) {
		try {
			assertExecutable(fromNpm);
			return fromNpm;
		} catch {
			// fall through
		}
	}

	const fromPath = findNodeOnPath();
	if (fromPath) return fromPath;

	throw new Error(
		`Could not resolve a Node.js executable to run kitty session runners ` +
			`(process.execPath=${process.execPath} is not plain node). ` +
			`Install node on PATH or set PI_INTERACTIVE_NODE to a node binary.`,
	);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

/** True when path looks like a normal node/nodejs binary, not pi/bun host CLIs. */
export function isPlainNodeBinary(filePath: string): boolean {
	const base = basename(filePath).toLowerCase();
	if (base === "node" || base === "nodejs") return true;
	if (base === "node.exe" || base === "nodejs.exe") return true;
	// Refuse known embedders / SEA hosts even if they report process.versions.node
	if (base === "pi" || base === "pi.exe") return false;
	if (base === "bun" || base === "bun.exe") return false;
	return false;
}

function assertExecutable(filePath: string): void {
	accessSync(filePath, constants.X_OK);
}

function findNodeOnPath(): string | undefined {
	const whichCmd = process.platform === "win32" ? "where.exe" : "which";
	try {
		const stdout = execFileSync(whichCmd, ["node"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const first = stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0);
		if (!first) return undefined;
		assertExecutable(first);
		return first;
	} catch {
		return undefined;
	}
}
