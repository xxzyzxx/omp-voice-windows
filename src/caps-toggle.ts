/**
 * [omp-windows patch] Caps Lock as a dictation toggle, with its LED as the
 * recording light.
 *
 * Press Caps Lock while this OMP window has focus: dictation starts. Press it
 * again (anywhere): dictation stops. The keyboard's Caps Lock LED is kept equal
 * to "recording": if Caps Lock was already on when dictation started, the
 * press turned it off, so it is switched back on; when a session ends any
 * other way (prompt sent, error) it is switched off. Presses while OMP is not
 * focused, or while a dialog has the input, are ordinary Caps Lock presses.
 *
 * Caps Lock produces no terminal input, so presses and the toggle state are
 * read from the OS (GetAsyncKeyState / GetKeyState).
 */
import { capsLockOn, consoleFocused, keyDown, tapKey, VK_CAPITAL } from "./win-keystate.ts";

const POLL_MS = 30;
/** Our own synthetic Caps Lock tap must not count as a user press. */
const OWN_TAP_GRACE_MS = 150;

export type CapsToggleHandlers = {
	/** A session is starting or running. */
	isDictating(): boolean;
	/** The prompt editor can take dictation (no dialog in front of it). */
	canStart(): boolean;
	start(): void;
	stop(): void;
};

export class CapsToggle {
	#timer: ReturnType<typeof setInterval> | undefined;
	#wasDown = false;
	/** The LED is on because of a dictation this toggle started. */
	#ownsLed = false;
	#ignoreUntil = 0;

	constructor(private readonly handlers: CapsToggleHandlers) {}

	start(): void {
		if (this.#timer || keyDown(VK_CAPITAL) === undefined) return;
		this.#timer = setInterval(() => this.#poll(), POLL_MS);
		this.#timer.unref?.();
	}

	stop(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#settleLed(false);
	}

	#tap(): void {
		this.#ignoreUntil = Date.now() + OWN_TAP_GRACE_MS;
		tapKey(VK_CAPITAL);
	}

	/** Make the LED show `recording`; only ever turns off a light we turned on. */
	#settleLed(recording: boolean): void {
		const on = capsLockOn() === true;
		if (recording && !on) this.#tap();
		if (!recording && this.#ownsLed && on) this.#tap();
		this.#ownsLed = recording;
	}

	#poll(): void {
		const down = keyDown(VK_CAPITAL) === true;
		const pressed = down && !this.#wasDown && Date.now() >= this.#ignoreUntil;
		this.#wasDown = down;

		if (pressed) {
			if (this.handlers.isDictating()) {
				// The press itself turned the LED off.
				this.#ownsLed = false;
				this.handlers.stop();
			} else if (consoleFocused() !== false && this.handlers.canStart()) {
				this.#ownsLed = true;
				this.handlers.start();
			}
			return;
		}
		// Settle once the key is up, so the toggle Windows applies on press is in.
		if (!down && Date.now() >= this.#ignoreUntil) {
			const dictating = this.handlers.isDictating();
			if (dictating !== this.#ownsLed || (dictating && capsLockOn() === false)) this.#settleLed(dictating);
		}
	}
}
