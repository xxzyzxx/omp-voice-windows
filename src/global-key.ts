/**
 * [omp-windows patch] System-wide hold-to-talk key.
 *
 * Terminal input only arrives while the OMP window has focus. This watcher
 * reads the physical state of one dedicated key (default Right Ctrl) with
 * GetAsyncKeyState, so dictation also works while OMP is in the background.
 * The key is not intercepted, so it must be one that does nothing when held on
 * its own. Pressing any other key with it (a Ctrl shortcut) is not a hold:
 * before the hold starts it blocks it, during the hold it cancels it.
 *
 * Release is detected by SpaceHold's own OS-state poll; this class only
 * reports the start of a hold and chords.
 */
import { consoleFocused, keyDown } from "./win-keystate.ts";

const POLL_MS = 30;

/** Keys that turn a held global key into a shortcut: everything but modifiers. */
const OTHER_KEYS = [
	0x08, 0x09, 0x0d, 0x1b, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e,
	...Array.from({ length: 0x5a - 0x30 + 1 }, (_, i) => 0x30 + i),
	...Array.from({ length: 0x7b - 0x60 + 1 }, (_, i) => 0x60 + i),
	0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc0, 0xdb, 0xdc, 0xdd, 0xde,
];

type Phase = { kind: "idle" } | { kind: "pending"; since: number } | { kind: "held" } | { kind: "blocked" };

export type GlobalKeyHandlers = {
	/** The key has been held alone long enough. */
	onHold(vk: number): void;
	/** Another key went down during a hold: it was a shortcut, not dictation. */
	onChord(): void;
};

export class GlobalKey {
	#timer: ReturnType<typeof setInterval> | undefined;
	#phase: Phase = { kind: "idle" };

	constructor(
		private readonly vk: number,
		private readonly holdMs: number,
		private readonly handlers: GlobalKeyHandlers,
		/** Only start while this OMP window has keyboard focus (the in-window dictation key). */
		private readonly focusOnly = false,
	) {}

	start(): void {
		if (this.#timer || keyDown(this.vk) === undefined) return;
		this.#timer = setInterval(() => this.#poll(), POLL_MS);
		this.#timer.unref?.();
	}

	stop(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#phase = { kind: "idle" };
	}

	#otherKeyDown(): boolean {
		return OTHER_KEYS.some((key) => key !== this.vk && keyDown(key) === true);
	}

	#poll(): void {
		const down = keyDown(this.vk) === true;
		const phase = this.#phase;
		if (!down) {
			this.#phase = { kind: "idle" };
			return;
		}
		switch (phase.kind) {
			case "idle":
				this.#phase =
					this.#otherKeyDown() || (this.focusOnly && consoleFocused() === false)
						? { kind: "blocked" }
						: { kind: "pending", since: Date.now() };
				return;
			case "pending":
				if (this.#otherKeyDown()) {
					this.#phase = { kind: "blocked" };
				} else if (Date.now() - phase.since >= this.holdMs) {
					this.#phase = { kind: "held" };
					this.handlers.onHold(this.vk);
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
