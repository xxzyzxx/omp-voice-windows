/**
 * [omp-windows patch] Hold-to-talk on a dedicated key, read from the OS.
 *
 * Used by voice-only mode's global key (default Right Ctrl), which dictates
 * even while OMP is in the background, and by a focus key other than Caps
 * Lock, which dictates only while this OMP window has focus. (Caps Lock is a
 * toggle instead; see caps-toggle.ts.)
 *
 * Keys are not intercepted, so they must be harmless when held alone.
 * Pressing another key with it is a shortcut, not a hold: before the hold
 * starts it blocks it, during the hold it cancels it.
 *
 * Release is detected by SpaceHold's own OS-state poll; this class only
 * reports the start of a hold and chords.
 */
import { consoleFocused, keyDown } from "./win-keystate.ts";

const POLL_MS = 30;

/** Keys that turn a held key into a shortcut: everything but modifiers. */
const OTHER_KEYS = [
	0x08, 0x09, 0x0d, 0x1b, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e,
	...Array.from({ length: 0x5a - 0x30 + 1 }, (_, i) => 0x30 + i),
	...Array.from({ length: 0x7b - 0x60 + 1 }, (_, i) => 0x60 + i),
	0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc0, 0xdb, 0xdc, 0xdd, 0xde,
];

type Phase = { kind: "idle" } | { kind: "pending"; since: number } | { kind: "held" } | { kind: "blocked" };

export type KeyHoldHandlers = {
	/** The key has been held alone long enough. */
	onHold(vk: number): void;
	/** Another key went down during a hold: it was a shortcut, not dictation. */
	onChord(): void;
};

export type KeyHoldOptions = {
	vk: number;
	holdMs: number;
	/** Only start while this OMP window has keyboard focus. */
	focusOnly: boolean;
};

export class KeyHold {
	#timer: ReturnType<typeof setInterval> | undefined;
	#phase: Phase = { kind: "idle" };

	constructor(
		private readonly options: KeyHoldOptions,
		private readonly handlers: KeyHoldHandlers,
	) {}

	start(): void {
		if (this.#timer || keyDown(this.options.vk) === undefined) return;
		this.#timer = setInterval(() => this.#poll(), POLL_MS);
		this.#timer.unref?.();
	}

	stop(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#phase = { kind: "idle" };
	}

	#otherKeyDown(): boolean {
		return OTHER_KEYS.some((key) => key !== this.options.vk && keyDown(key) === true);
	}

	#poll(): void {
		const { vk, holdMs, focusOnly } = this.options;
		const down = keyDown(vk) === true;
		const phase = this.#phase;
		if (!down) {
			this.#phase = { kind: "idle" };
			return;
		}
		switch (phase.kind) {
			case "idle":
				this.#phase =
					this.#otherKeyDown() || (focusOnly && consoleFocused() === false)
						? { kind: "blocked" }
						: { kind: "pending", since: Date.now() };
				return;
			case "pending":
				if (this.#otherKeyDown()) {
					this.#phase = { kind: "blocked" };
				} else if (Date.now() - phase.since >= holdMs) {
					this.#phase = { kind: "held" };
					this.handlers.onHold(vk);
				}
				return;
			case "held":
				if (this.#otherKeyDown()) {
					this.#phase = { kind: "blocked" };
					this.handlers.onChord();
				}
				return;
			case "blocked":
				return;
		}
	}
}
