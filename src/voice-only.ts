/**
 * [omp-windows patch] Voice-only mode: one hold = one prompt, from any window.
 *
 * Off by default; the normal mode (hold Space in the focused prompt, press
 * Enter yourself) is unchanged. When on:
 * - a dedicated global key (default Right Ctrl) starts dictation even while the
 *   OMP window is in the background, and its release ends it;
 * - every dictation that produced text is submitted as if Enter were pressed.
 *
 * Only one OMP process may own the global key, or every open window would
 * dictate and send the same prompt. Ownership is a loopback port: the first
 * process to bind it owns the key until it leaves voice-only mode or exits.
 */
import net from "node:net";
import { GlobalKey } from "./global-key.ts";
import type { SpaceHold } from "./hold.ts";
import { globalHoldMs, globalKey, setVoiceOnly, voiceOnly } from "./local-config.ts";

const OWNER_PORT = 47799;

function claimOwnership(): Promise<net.Server | undefined> {
	const { promise, resolve } = Promise.withResolvers<net.Server | undefined>();
	const server = net.createServer((socket) => socket.destroy());
	server.once("error", () => resolve(undefined));
	server.listen({ host: "127.0.0.1", port: OWNER_PORT, exclusive: true }, () => {
		server.unref();
		resolve(server);
	});
	return promise;
}

export class VoiceOnlyMode {
	#key: GlobalKey | undefined;
	#owner: net.Server | undefined;
	#active = false;

	constructor(private readonly hold: SpaceHold) {}

	/** Whether dictations are submitted automatically. */
	get active(): boolean {
		return this.#active;
	}

	/** Apply the persisted mode (session start). Returns a notice, if any. */
	async restore(): Promise<string | undefined> {
		return voiceOnly() ? this.enable() : undefined;
	}

	async enable(): Promise<string> {
		setVoiceOnly(true);
		this.#active = true;
		const vk = globalKey();
		if (vk === undefined) return "Voice-only mode on: global key off; hold Space in this window, release to send";
		if (!this.#owner) this.#owner = await claimOwnership();
		if (!this.#owner) {
			return "Voice-only mode on, but another OMP window owns the global key; hold Space here, release to send";
		}
		this.#key?.stop();
		this.#key = new GlobalKey(vk, globalHoldMs(), {
			onHold: (key) => this.hold.beginGlobal(key),
			onChord: () => this.hold.cancel(),
		});
		this.#key.start();
		return `Voice-only mode on: hold the global key (0x${vk.toString(16)}) anywhere, release to send`;
	}

	disable(persist = true): void {
		if (persist) setVoiceOnly(false);
		this.#active = false;
		this.#key?.stop();
		this.#key = undefined;
		this.#owner?.close();
		this.#owner = undefined;
	}
}
