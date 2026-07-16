/**
 * Key tokens for kitty `send-key` (and fallback escape encoding).
 *
 * Vocabulary follows kitty 0.47.x `parse_shortcut` / `send-key`:
 * - Modifiers joined with `+` only: ctrl/control, alt/opt/option, shift, super/cmd/command, hyper, kitty
 * - Functional key names and aliases from kitty's GLFW_FKEY_* + functional_key_name_aliases
 * - Single-character keys only when combined with a modifier (bare letters go through send-text)
 *
 * Not accepted (kitty silently ignores or parse fails): c-/m-/s- shorthand, ctrl-c with '-',
 * tmux-only aliases (bspace, btab, dc, ic, ppage, npage, kp0, kp+).
 */

/** kitty functional key names (lowercase), from GLFW_FKEY_*. */
const KITTY_FUNCTIONAL_KEYS = new Set([
	"escape",
	"enter",
	"tab",
	"backspace",
	"insert",
	"delete",
	"left",
	"right",
	"up",
	"down",
	"page_up",
	"page_down",
	"home",
	"end",
	"caps_lock",
	"scroll_lock",
	"num_lock",
	"print_screen",
	"pause",
	"menu",
	"f1",
	"f2",
	"f3",
	"f4",
	"f5",
	"f6",
	"f7",
	"f8",
	"f9",
	"f10",
	"f11",
	"f12",
	"f13",
	"f14",
	"f15",
	"f16",
	"f17",
	"f18",
	"f19",
	"f20",
	"f21",
	"f22",
	"f23",
	"f24",
	"f25",
	"f26",
	"f27",
	"f28",
	"f29",
	"f30",
	"f31",
	"f32",
	"f33",
	"f34",
	"f35",
	"kp_0",
	"kp_1",
	"kp_2",
	"kp_3",
	"kp_4",
	"kp_5",
	"kp_6",
	"kp_7",
	"kp_8",
	"kp_9",
	"kp_decimal",
	"kp_divide",
	"kp_multiply",
	"kp_subtract",
	"kp_add",
	"kp_enter",
	"kp_equal",
	"kp_separator",
	"kp_left",
	"kp_right",
	"kp_up",
	"kp_down",
	"kp_page_up",
	"kp_page_down",
	"kp_home",
	"kp_end",
	"kp_insert",
	"kp_delete",
	"kp_begin",
	"media_play",
	"media_pause",
	"media_play_pause",
	"media_reverse",
	"media_stop",
	"media_fast_forward",
	"media_rewind",
	"media_track_next",
	"media_track_previous",
	"media_record",
	"lower_volume",
	"raise_volume",
	"mute_volume",
	"left_shift",
	"left_control",
	"left_alt",
	"left_super",
	"left_hyper",
	"left_meta",
	"right_shift",
	"right_control",
	"right_alt",
	"right_super",
	"right_hyper",
	"right_meta",
	"iso_level3_shift",
	"iso_level5_shift",
]);

/** kitty functional_key_name_aliases (lowercase). */
const KITTY_FUNCTIONAL_ALIASES: Record<string, string> = {
	esc: "escape",
	return: "enter",
	del: "delete",
	pgup: "page_up",
	pageup: "page_up",
	pgdn: "page_down",
	pagedown: "page_down",
	arrowup: "up",
	arrowdown: "down",
	arrowleft: "left",
	arrowright: "right",
	kp_plus: "kp_add",
	kp_minus: "kp_subtract",
};

/** Named character keys kitty accepts instead of a literal glyph. */
const KITTY_CHAR_ALIASES = new Set([
	"space",
	"spc",
	"plus",
	"minus",
	"hyphen",
	"star",
	"multiply",
	"bar",
	"pipe",
	"equal",
	"underscore",
	"comma",
	"period",
	"dot",
	"slash",
	"backslash",
	"tilde",
	"grave",
	"grave_accent",
	"apostrophe",
	"semicolon",
	"colon",
	"left_bracket",
	"right_bracket",
]);

/** Modifier names accepted by kitty parse_mods / mod_map (plus control/alt/shift/super/hyper). */
const KITTY_MODIFIERS = new Set([
	"ctrl",
	"control",
	"⌃",
	"alt",
	"option",
	"opt",
	"⌥",
	"shift",
	"⇧",
	"super",
	"cmd",
	"command",
	"⌘",
	"hyper",
	"kitty",
	"kitty_mod",
	"none",
]);

// Escape sequences for fallback send-text encoding (when session has no native send-key).
const NAMED_KEYS: Record<string, string> = {
	up: "\x1b[A",
	down: "\x1b[B",
	left: "\x1b[D",
	right: "\x1b[C",
	enter: "\r",
	return: "\r",
	escape: "\x1b",
	esc: "\x1b",
	tab: "\t",
	space: " ",
	spc: " ",
	backspace: "\x7f",
	delete: "\x1b[3~",
	del: "\x1b[3~",
	insert: "\x1b[2~",
	home: "\x1b[H",
	end: "\x1b[F",
	page_up: "\x1b[5~",
	pageup: "\x1b[5~",
	pgup: "\x1b[5~",
	page_down: "\x1b[6~",
	pagedown: "\x1b[6~",
	pgdn: "\x1b[6~",
	f1: "\x1bOP",
	f2: "\x1bOQ",
	f3: "\x1bOR",
	f4: "\x1bOS",
	f5: "\x1b[15~",
	f6: "\x1b[17~",
	f7: "\x1b[18~",
	f8: "\x1b[19~",
	f9: "\x1b[20~",
	f10: "\x1b[21~",
	f11: "\x1b[23~",
	f12: "\x1b[24~",
	kp_0: "\x1bOp",
	kp_1: "\x1bOq",
	kp_2: "\x1bOr",
	kp_3: "\x1bOs",
	kp_4: "\x1bOt",
	kp_5: "\x1bOu",
	kp_6: "\x1bOv",
	kp_7: "\x1bOw",
	kp_8: "\x1bOx",
	kp_9: "\x1bOy",
	kp_divide: "\x1bOo",
	kp_multiply: "\x1bOj",
	kp_subtract: "\x1bOm",
	kp_add: "\x1bOk",
	kp_decimal: "\x1bOn",
	kp_enter: "\x1bOM",
	kp_plus: "\x1bOk",
	kp_minus: "\x1bOm",
};

const CTRL_KEYS: Record<string, string> = {};
for (let i = 0; i < 26; i++) {
	const char = String.fromCharCode(97 + i);
	CTRL_KEYS[`ctrl+${char}`] = String.fromCharCode(i + 1);
	CTRL_KEYS[`control+${char}`] = String.fromCharCode(i + 1);
}
CTRL_KEYS["ctrl+["] = "\x1b";
CTRL_KEYS["ctrl+\\"] = "\x1c";
CTRL_KEYS["ctrl+]"] = "\x1d";
CTRL_KEYS["ctrl+^"] = "\x1e";
CTRL_KEYS["ctrl+_"] = "\x1f";
CTRL_KEYS["ctrl+?"] = "\x7f";

function altKey(char: string): string {
	return `\x1b${char}`;
}

const MODIFIABLE_KEYS = new Set([
	"up",
	"down",
	"left",
	"right",
	"home",
	"end",
	"page_up",
	"pageup",
	"pgup",
	"page_down",
	"pagedown",
	"pgdn",
	"insert",
	"delete",
	"del",
]);

function xtermModifier(shift: boolean, alt: boolean, ctrl: boolean): number {
	let mod = 1;
	if (shift) mod += 1;
	if (alt) mod += 2;
	if (ctrl) mod += 4;
	return mod;
}

function applyXtermModifier(sequence: string, modifier: number): string | null {
	const arrowMatch = sequence.match(/^\x1b\[([A-D])$/);
	if (arrowMatch) {
		return `\x1b[1;${modifier}${arrowMatch[1]}`;
	}
	const numMatch = sequence.match(/^\x1b\[(\d+)~$/);
	if (numMatch) {
		return `\x1b[${numMatch[1]};${modifier}~`;
	}
	const hfMatch = sequence.match(/^\x1b\[([HF])$/);
	if (hfMatch) {
		return `\x1b[1;${modifier}${hfMatch[1]}`;
	}
	return null;
}

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function encodePaste(text: string, bracketed = true): string {
	if (!bracketed) return text;
	return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

/** Strip kitty-style modifiers (`ctrl+`, `alt+`, …). Hyphen shorthands are not supported. */
function stripKeyModifiers(token: string): { rest: string; ctrl: boolean; alt: boolean; shift: boolean; superMod: boolean } {
	const parts = token.split("+");
	if (parts.length <= 1) {
		return { rest: token, ctrl: false, alt: false, shift: false, superMod: false };
	}
	let ctrl = false;
	let alt = false;
	let shift = false;
	let superMod = false;
	const key = parts[parts.length - 1]!;
	for (const raw of parts.slice(0, -1)) {
		const m = raw.trim().toLowerCase();
		if (m === "ctrl" || m === "control" || m === "⌃") ctrl = true;
		else if (m === "alt" || m === "option" || m === "opt" || m === "⌥") alt = true;
		else if (m === "shift" || m === "⇧") shift = true;
		else if (m === "super" || m === "cmd" || m === "command" || m === "⌘") superMod = true;
		// hyper/kitty ignored for escape encoding
	}
	return { rest: key, ctrl, alt, shift, superMod };
}

function resolveFunctionalName(name: string): string {
	return KITTY_FUNCTIONAL_ALIASES[name] ?? name;
}

function isKittyFunctionalOrCharKey(name: string): boolean {
	if (!name) return false;
	if (KITTY_FUNCTIONAL_KEYS.has(resolveFunctionalName(name))) return true;
	if (KITTY_CHAR_ALIASES.has(name)) return true;
	// Bare single codepoint: kitty accepts as send-key, but we prefer send-text for reliability
	// under alternate-screen TUIs. Only treat as named when it is a known alias or functional key.
	return false;
}

function isKittyModifierPart(part: string): boolean {
	return KITTY_MODIFIERS.has(part.trim().toLowerCase());
}

/**
 * Whether a key token is a valid kitty `send-key` keysym (not a literal to type).
 * Mirrors kitty `options.utils.parse_shortcut` + functional/character aliases.
 *
 * Pitfall: kitty's send-key silently drops unrecognized keysyms while reporting success.
 * Only route tokens that parse to a real key through send-key; everything else → send-text.
 */
export function isNamedKey(token: string): boolean {
	let sc = token.trim().toLowerCase();
	if (!sc) return false;
	// kitty: trailing bare "+" means the key "plus" (e.g. "ctrl++" → "ctrl+plus")
	if (sc.endsWith("+") && sc.length > 1) {
		sc = `${sc.slice(0, -1)}plus`;
	}
	const parts = sc.split("+");
	// Empty segments (e.g. "++" → "+plus") are not valid shortcuts.
	if (parts.length === 0 || parts.some((p) => p.length === 0)) return false;

	if (parts.length > 1) {
		for (const mod of parts.slice(0, -1)) {
			if (!isKittyModifierPart(mod)) return false;
		}
		const key = parts[parts.length - 1]!;
		// modifier + single character (ctrl+c, alt+x, …)
		if ([...key].length === 1) return true;
		return isKittyFunctionalOrCharKey(key);
	}

	// Bare functional / named character key (enter, tab, space, f1, kp_enter, …)
	return isKittyFunctionalOrCharKey(parts[0]!);
}

/** Parse a key token and return the escape sequence (fallback path without kitty send-key). */
function encodeKeyToken(token: string): string {
	const normalized = token.trim().toLowerCase();
	if (!normalized) return "";

	if (NAMED_KEYS[normalized]) {
		return NAMED_KEYS[normalized];
	}
	if (CTRL_KEYS[normalized]) {
		return CTRL_KEYS[normalized];
	}

	// Trailing + → plus (kitty style)
	let sc = normalized;
	if (sc.endsWith("+") && sc.length > 1) {
		sc = `${sc.slice(0, -1)}plus`;
	}

	const { rest, ctrl, alt, shift } = stripKeyModifiers(sc);
	const keyName = resolveFunctionalName(rest);

	if (shift && (rest === "tab" || keyName === "tab")) {
		return "\x1b[Z";
	}

	const baseSeq = NAMED_KEYS[rest] ?? NAMED_KEYS[keyName];
	if (baseSeq && (MODIFIABLE_KEYS.has(rest) || MODIFIABLE_KEYS.has(keyName))) {
		const mod = xtermModifier(shift, alt, ctrl);
		if (mod > 1) {
			const modified = applyXtermModifier(baseSeq, mod);
			if (modified) return modified;
		}
	}

	if (rest.length === 1) {
		let char = rest;
		if (shift && /[a-z]/.test(char)) {
			char = char.toUpperCase();
		}
		if (ctrl) {
			const ctrlChar = CTRL_KEYS[`ctrl+${char.toLowerCase()}`];
			if (ctrlChar) char = ctrlChar;
		}
		if (alt) {
			return altKey(char);
		}
		return char;
	}

	if (baseSeq && alt) {
		return `\x1b${baseSeq}`;
	}
	if (baseSeq) {
		return baseSeq;
	}
	return token;
}

/** Translate input specification to terminal escape sequences (fallback when no native send-key). */
export function translateInput(input: string | { text?: string; keys?: string[]; paste?: string; hex?: string[] }): string {
	if (typeof input === "string") {
		return input;
	}

	let result = "";

	if (input.hex?.length) {
		for (const raw of input.hex) {
			const trimmed = raw.trim().toLowerCase();
			const normalized = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
			if (/^[0-9a-f]{1,2}$/.test(normalized)) {
				const value = Number.parseInt(normalized, 16);
				if (!Number.isNaN(value) && value >= 0 && value <= 0xff) {
					result += String.fromCharCode(value);
				}
			}
		}
	}

	if (input.text) {
		result += input.text;
	}

	if (input.paste) {
		result += encodePaste(input.paste);
	}

	if (input.keys) {
		for (const key of input.keys) {
			result += encodeKeyToken(key);
		}
	}

	return result;
}
