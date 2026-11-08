/**
 * [omp-windows patch] Local user config: `%USERPROFILE%\.omp\push-to-talk.json`.
 *
 *   {
 *     "device": "Microphone",   // capture device name substring (default: OS default input)
 *     "focusKey": "CapsLock",   // hold-to-talk while this OMP window has focus ("Space" = upstream behaviour)
 *     "focusHoldMs": 200,       // how long the focus key must be held alone
 *     "voiceOnly": false,       // voice-only mode, toggled by /voice-only
 *     "globalKey": "RightCtrl", // voice-only mode: system-wide hold-to-talk key
 *     "globalHoldMs": 250       // voice-only mode: how long that key must be held alone
 *   }
 *
 * The OS default input may be a virtual cable (voice changers, VB-Audio), which
 * records silence, hence `device`. `PI_DICTATION_DEVICE` overrides it.
 * Read on every use, so edits apply without restarting OMP.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOCAL_CONFIG_FILE = path.join(os.homedir(), ".omp", "push-to-talk.json");

type LocalConfig = {
	device?: unknown;
	focusKey?: unknown;
	focusHoldMs?: unknown;
	voiceOnly?: unknown;
	globalKey?: unknown;
	globalHoldMs?: unknown;
};

function readConfig(): LocalConfig {
	try {
		return JSON.parse(fs.readFileSync(LOCAL_CONFIG_FILE, "utf8")) as LocalConfig;
	} catch {
		return {};
	}
}

/** Persist voice-only mode, keeping every other key in the file. */
export function setVoiceOnly(on: boolean): void {
	fs.mkdirSync(path.dirname(LOCAL_CONFIG_FILE), { recursive: true });
	fs.writeFileSync(LOCAL_CONFIG_FILE, `${JSON.stringify({ ...readConfig(), voiceOnly: on }, null, 2)}\n`);
}

export function voiceOnly(): boolean {
	return readConfig().voiceOnly === true;
}

export function captureDevice(): string | undefined {
	const env = process.env.PI_DICTATION_DEVICE?.trim();
	if (env) return env;
	const { device } = readConfig();
	return typeof device === "string" && device.trim() ? device.trim() : undefined;
}

/** Virtual-key codes for keys that are harmless to hold. */
const KEY_NAMES: Record<string, number> = {
	capslock: 0x14,
	rightctrl: 0xa3,
	scrolllock: 0x91,
	xbutton1: 0x05,
	xbutton2: 0x06,
	...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${13 + i}`, 0x7c + i])),
};

function parseKey(key: unknown): number | undefined {
	if (typeof key === "number" && key > 0 && key < 0xff) return key;
	if (typeof key !== "string") return undefined;
	return KEY_NAMES[key.trim().toLowerCase().replace(/[\s_-]/g, "")];
}

function parseMs(ms: unknown, fallback: number): number {
	return typeof ms === "number" && ms >= 0 ? ms : fallback;
}

/**
 * The in-window hold-to-talk key: "space" for upstream Space handling, a
 * virtual-key code for an OS-polled key, undefined when "off".
 */
export function focusKey(): number | "space" | undefined {
	const { focusKey: key = "CapsLock" } = readConfig();
	if (typeof key === "string" && key.trim().toLowerCase() === "space") return "space";
	return parseKey(key);
}

export function focusHoldMs(): number {
	return parseMs(readConfig().focusHoldMs, 200);
}

/** Voice-only mode's global hold-to-talk key as a virtual-key code; undefined when "off". */
export function globalKey(): number | undefined {
	return parseKey(readConfig().globalKey ?? "RightCtrl");
}

export function globalHoldMs(): number {
	return parseMs(readConfig().globalHoldMs, 250);
}
