import { describe, expect, it } from "vitest";
import { isNamedKey, translateInput } from "../key-encoding.js";

describe("translateInput", () => {
	it("encodes named keys and modifiers with kitty + syntax", () => {
		expect(translateInput({ keys: ["up", "shift+tab", "ctrl+c", "alt+x"] })).toBe("\x1b[A\x1b[Z\x03\x1bx");
	});

	it("emits paste before trailing keys so pasted input can be submitted afterward", () => {
		expect(
			translateInput({
				text: "hi",
				keys: ["enter"],
				hex: ["0x21"],
				paste: "body",
			}),
		).toBe("!hi\x1b[200~body\x1b[201~\r");
	});

	it("supports xterm modifier encoding for CSI keys", () => {
		expect(translateInput({ keys: ["ctrl+alt+delete", "shift+up"] })).toBe("\x1b[3;7~\x1b[1;2A");
	});
});

describe("isNamedKey (kitty send-key vocabulary)", () => {
	it("accepts kitty functional keys and + modifiers", () => {
		expect(isNamedKey("enter")).toBe(true);
		expect(isNamedKey("return")).toBe(true);
		expect(isNamedKey("escape")).toBe(true);
		expect(isNamedKey("esc")).toBe(true);
		expect(isNamedKey("up")).toBe(true);
		expect(isNamedKey("f1")).toBe(true);
		expect(isNamedKey("page_up")).toBe(true);
		expect(isNamedKey("pageup")).toBe(true);
		expect(isNamedKey("pgup")).toBe(true);
		expect(isNamedKey("kp_enter")).toBe(true);
		expect(isNamedKey("kp_add")).toBe(true);
		expect(isNamedKey("space")).toBe(true);
		expect(isNamedKey("ctrl+c")).toBe(true);
		expect(isNamedKey("control+c")).toBe(true);
		expect(isNamedKey("alt+k")).toBe(true);
		expect(isNamedKey("opt+x")).toBe(true);
		expect(isNamedKey("shift+tab")).toBe(true);
		expect(isNamedKey("ctrl+alt+delete")).toBe(true);
		expect(isNamedKey("cmd+c")).toBe(true);
		expect(isNamedKey("super+c")).toBe(true);
	});

	it("rejects non-kitty aliases and literals (route to send-text or invalid)", () => {
		// Hyphen shorthands are NOT kitty send-key syntax
		expect(isNamedKey("c-c")).toBe(false);
		expect(isNamedKey("m-x")).toBe(false);
		expect(isNamedKey("s-tab")).toBe(false);
		expect(isNamedKey("ctrl-c")).toBe(false);
		// tmux-only aliases
		expect(isNamedKey("bspace")).toBe(false);
		expect(isNamedKey("btab")).toBe(false);
		expect(isNamedKey("dc")).toBe(false);
		expect(isNamedKey("ic")).toBe(false);
		expect(isNamedKey("ppage")).toBe(false);
		expect(isNamedKey("npage")).toBe(false);
		expect(isNamedKey("kp0")).toBe(false);
		expect(isNamedKey("kp+")).toBe(false);
		// bare letters / multi-char literals → send-text
		expect(isNamedKey("+")).toBe(false);
		expect(isNamedKey("q")).toBe(false);
		expect(isNamedKey("abc")).toBe(false);
		expect(isNamedKey("++")).toBe(false);
		expect(isNamedKey("你好")).toBe(false);
	});
});
