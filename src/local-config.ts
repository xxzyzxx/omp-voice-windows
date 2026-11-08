/**
 * [omp-windows patch] Local user config for the capture device.
 *
 * The OS default input may be a virtual cable (voice changers, VB-Audio), which
 * records silence. `%USERPROFILE%\.omp\push-to-talk.json` can name the device:
 *
 *   { "device": "Microphone" }
 *
 * `device` is a case-insensitive name substring, as decibri accepts. The
 * `PI_DICTATION_DEVICE` environment variable overrides the file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOCAL_CONFIG_FILE = path.join(os.homedir(), ".omp", "push-to-talk.json");

export function captureDevice(): string | undefined {
	const env = process.env.PI_DICTATION_DEVICE?.trim();
	if (env) return env;
	try {
		const parsed = JSON.parse(fs.readFileSync(LOCAL_CONFIG_FILE, "utf8")) as { device?: unknown };
		return typeof parsed.device === "string" && parsed.device.trim() ? parsed.device.trim() : undefined;
	} catch {
		return undefined;
	}
}
