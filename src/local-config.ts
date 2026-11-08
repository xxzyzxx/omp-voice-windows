/**
 * [omp-windows patch] Local user config: `%USERPROFILE%\.omp\push-to-talk.json`.
 *
 *   {
 *     "device": "Microphone",   // capture device name substring (default: OS default input)
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

type LocalConfig = { device?: unknown; voiceOnly?: unknown; globalKey?: unknown; globalHoldMs?: unknown };

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

/** Virtual-key codes for keys that are harmless to hold in other applications. */
const KEY_NAMES: Record<string, number> = {
	rightctrl: 0xa3,
	scrolllock: 0x91,
	xbutton1: 0x05,
	xbutton2: 0x06,
	...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${13 + i}`, 0x7c + i])),
};

/** Voice-only mode's global hold-to-talk key as a virtual-key code; undefined when "off". */
export function globalKey(): number | undefined {
	const { globalKey: key = "RightCtrl" } = readConfig();
	if (typeof key === "number" && key > 0 && key < 0xff) return key;
	if (typeof key !== "string") return undefined;
	return KEY_NAMES[key.trim().toLowerCase().replace(/[\s_-]/g, "")];
}

export function globalHoldMs(): number {
	const { globalHoldMs: ms } = readConfig();
	return typeof ms === "number" && ms >= 0 ? ms : 250;
}
