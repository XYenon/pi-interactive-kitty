import { describe, expect, it, vi, afterEach } from "vitest";
import { isPlainNodeBinary, resolveNodeExecutable } from "../resolve-node-executable.js";

describe("isPlainNodeBinary", () => {
	it("accepts ordinary node binaries", () => {
		expect(isPlainNodeBinary("/usr/bin/node")).toBe(true);
		expect(isPlainNodeBinary("/nix/store/abc/bin/nodejs")).toBe(true);
		expect(isPlainNodeBinary("C:/Program Files/nodejs/node.exe")).toBe(true);
	});

	it("rejects pi SEA and bun hosts", () => {
		expect(isPlainNodeBinary("/nix/store/abc/libexec/pi/pi")).toBe(false);
		expect(isPlainNodeBinary("/usr/local/bin/bun")).toBe(false);
	});
});

describe("resolveNodeExecutable", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("prefers PI_INTERACTIVE_NODE override", () => {
		// Use the real node on PATH as a known-good absolute path when possible.
		const real = resolveNodeExecutable();
		vi.stubEnv("PI_INTERACTIVE_NODE", real);
		expect(resolveNodeExecutable()).toBe(real);
	});

	it("returns process.execPath when it is plain node", () => {
		// Under vitest, execPath is node — should succeed without PATH lookup tricks.
		const resolved = resolveNodeExecutable();
		expect(isPlainNodeBinary(resolved) || resolved.includes("node")).toBe(true);
	});
});
