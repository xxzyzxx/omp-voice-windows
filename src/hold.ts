/**
 * Hold SPACE to dictate.
 *
 * Hooks `ctx.ui.onTerminalInput`, the raw terminal path, because that is where
 * key repeats arrive. The press is left to the editor, so typing a space never
 * depends on this state machine: once the key repeats, the spaces the editor
 * typed are taken back and dictation starts.
 *
 * A repeat proves the key is still down, and it needs no release event. Kitty
 * names the event exactly; a terminal without the protocol sends the same bare
 * space for a repeat, so there only a press that closely follows the previous
 * one is evidence. Releases stop a session, but a terminal that sends none
 * still dictates.
 */
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import { REPEAT_GAP_MS, RELEASE_GAP_MS } from "./config.ts";
import { trace } from "./debug.ts";
import type { DictationEditor } from "./editor.ts";
import { createRegion } from "./region.ts";
import { DictationSession, type SessionUi } from "./session.ts";
import type { Stt } from "./stt.ts";
import { keyDown, VK_SPACE } from "./win-keystate.ts";

/** [omp-windows patch] How often the OS key state is read while a hold is live. */
const RELEASE_POLL_MS = 25;

export type HoldDeps = {
	getEditor: () => DictationEditor | undefined;
	getStt: () => Promise<Stt>;
	notify: (message: string, level: "info" | "warning" | "error") => void;
	status: (text: string | undefined) => void;
	/** Indicator text for a blink phase, already coloured. */
	indicator: (state: "loading" | "listening", filled: boolean, client?: string) => string;
	/** Test seam; production uses DictationSession. */
	createSession?: (stt: Stt | Promise<Stt>, ui: SessionUi) => DictationSession;
	/** [omp-windows patch] A dictation session is starting (e.g. silence speech output). */
	onStart?: () => void;
	/** [omp-windows patch] A voice-only global-key session ended with text in the editor: send it. */
	onCommitted?: () => void;
};

export class SpaceHold {
	private readonly deps: HoldDeps;
	private session: DictationSession | undefined;
	/** A space press may still become a hold until its release arrives. */
	private holding = false;
	private starting = false;
	private beginQueued = false;
	/** Bumped by each new press and by cancel; an older begin must not claim it. */
	private holdId = 0;
	/** When the previous space event arrived, to spot a missing release. */
	private lastSpaceAt = 0;
	/** Spaces this press typed into the editor that a hold must take back. */
	private typedSpaces = 0;
	/** Spaces an already running begin still has to take back. */
	private pendingDelete = 0;
	/** Resolves when the previous session finished its final decode. */
	private stopping: Promise<unknown> = Promise.resolve();
	/** [omp-windows patch] Reads the physical hold key while a hold is live. */
	private releasePoll: ReturnType<typeof setInterval> | undefined;
	/** [omp-windows patch] The key whose release ends the live hold: Space, or the global key. */
	private holdVk = VK_SPACE;
	/** [omp-windows patch] The live session was toggled on (Caps Lock), not held. */
	private toggle = false;
	/** [omp-windows patch] Voice-only global-key session: its transcript is sent on commit. */
	private submitOnCommit = false;

	constructor(deps: HoldDeps) {
		this.deps = deps;
	}

	/** Returns true when the event belongs to dictation and must be consumed. */
	handle(data: string): boolean {
		const released = isKeyRelease(data);

		const editor = this.deps.getEditor();

		// Raw terminal input is global: dialogs and nested editors receive it too.
		// Without this guard a space typed into a permission prompt would start
		// dictation instead of reaching that editor.
		if (editor && editor.focused === false) {
			if (this.session?.isActive()) this.cancel();
			return false;
		}

		if (matchesKey(data, "space")) {
			return this.handleSpace(released, isKeyRepeat(data));
		}

		return false;
	}

	/** Abandon any open session without committing, e.g. when the prompt is submitted. */
	cancel(): void {
		trace("cancel");
		this.holding = false;
		this.toggle = false;
		this.submitOnCommit = false;
		this.holdId++;
		this.beginQueued = false;
		this.typedSpaces = 0;
		this.pendingDelete = 0;
		this.stopReleasePoll();
		this.session?.cancel();
		this.session = undefined;
	}

	private handleSpace(released: boolean, repeated: boolean): boolean {
		const now = Date.now();
		// Auto-repeat of a held key arrives every few tens of ms; a press preceded
		// by a longer gap is a new press, so the release before it was lost.
		const gap = now - this.lastSpaceAt;
		this.lastSpaceAt = now;

		trace(
			`space release=${String(released)} repeat=${String(repeated)} gap=${gap} holding=${String(this.holding)} typed=${this.typedSpaces} active=${String(this.session?.isActive())}`,
		);

		if (this.session?.isActive()) {
			// Without this a terminal that drops key releases leaves the session
			// open forever, which means an open microphone.
			if (released || gap >= RELEASE_GAP_MS) this.finish();
			return true; // space events are meaningless while dictating
		}

		if (released) {
			this.holding = false;
			this.typedSpaces = 0;
			// A session that failed by itself is already stopping; keep that
			// shutdown visible to the next begin before the key is pressed again.
			this.finish();
			return false; // the space the editor typed stays
		}

		// A repeat proves the key is down, where a tap would have ended. Kitty
		// names the event; without it only a press this close to the previous one
		// can be a repeat of the same key. [omp-windows patch] Where the OS key
		// state is readable, the key must also be physically down: fast typing,
		// unbracketed pastes and injected input send spaces this close together.
		const hold = this.holding && (repeated || gap <= REPEAT_GAP_MS) && keyDown() !== false;
		if (!hold) {
			this.holding = true;
			this.typedSpaces = 1;
			this.holdId++;
			return false; // the editor types the space
		}

		// The triggering repeat is consumed, so only earlier presses typed a space.
		this.pendingDelete += this.typedSpaces;
		this.typedSpaces = 0;
		this.holdVk = VK_SPACE;
		this.toggle = false;
		this.submitOnCommit = false;
		this.requestBegin(this.holdId);
		return true;
	}

	/**
	 * [omp-windows patch] Start a hold from an OS-polled key (a non-Caps focus
	 * key, or voice-only mode's global key). No spaces were typed, so there is
	 * nothing to take back; the OS release poll ends it. `submit`: hand the
	 * transcript to onCommitted (voice-only mode sends it).
	 */
	beginKeyHold(vk: number, submit = false): void {
		if (this.dictating) return;
		trace(`key 0x${vk.toString(16)} held`);
		this.toggle = false;
		this.submitOnCommit = submit;
		this.holdVk = vk;
		this.holding = true;
		this.holdId++;
		this.typedSpaces = 0;
		this.pendingDelete = 0;
		this.requestBegin(this.holdId);
	}

	/**
	 * [omp-windows patch] Start a toggled dictation (Caps Lock): it runs until
	 * stopToggle(), a submitted prompt, or a failure; no key needs to stay down.
	 */
	beginToggle(): void {
		if (this.dictating) return;
		trace("toggle on");
		this.toggle = true;
		this.submitOnCommit = false;
		this.holding = true;
		this.holdId++;
		this.typedSpaces = 0;
		this.pendingDelete = 0;
		this.requestBegin(this.holdId);
	}

	/** [omp-windows patch] End a toggled dictation and keep its transcript. */
	stopToggle(): void {
		trace("toggle off");
		this.finish();
	}

	/** [omp-windows patch] A session is starting or running. */
	get dictating(): boolean {
		return this.starting || this.session?.isActive() === true;
	}

	private finish(): void {
		const submit = this.submitOnCommit;
		this.holding = false;
		this.toggle = false;
		this.submitOnCommit = false;
		this.stopReleasePoll();
		if (!this.session) return;
		this.stopping = this.session
			.stop()
			.then((committed) => {
				if (committed && submit) this.deps.onCommitted?.();
			})
			.catch((error: unknown) => {
				this.deps.notify(`Dictation: ${String(error)}`, "error");
			});
	}

	/**
	 * [omp-windows patch] The terminal never reports the release on Windows, so
	 * watch the physical key from the moment a hold is recognised. A missing OS
	 * reading (non-Windows) leaves the upstream terminal-release logic in charge.
	 */
	private startReleasePoll(id: number): void {
		this.stopReleasePoll();
		if (this.toggle || keyDown(this.holdVk) === undefined) return;
		this.releasePoll = setInterval(() => {
			try {
				if (id !== this.holdId) {
					this.stopReleasePoll();
					return;
				}
				if (keyDown(this.holdVk) === false) {
					trace("release from OS key state");
					this.finish();
				}
			} catch (error) {
				this.stopReleasePoll();
				trace(`release poll failed: ${String(error)}`);
			}
		}, RELEASE_POLL_MS);
	}

	private stopReleasePoll(): void {
		if (this.releasePoll) {
			clearInterval(this.releasePoll);
			this.releasePoll = undefined;
		}
	}

	/** Start against the given press; queue it when an older begin is still unwinding. */
	private requestBegin(id: number): void {
		if (id !== this.holdId) return;
		if (this.starting) {
			this.beginQueued = true;
			return;
		}
		void this.begin(id);
	}

	private async begin(id: number): Promise<void> {
		if (this.starting) {
			this.beginQueued = true;
			return;
		}
		this.starting = true;
		this.startReleasePoll(id);
		// finish() clears the flag when the key is released before capture began.
		const submit = this.submitOnCommit;
		let takenBack = 0;
		try {
			const editor = this.deps.getEditor();
			if (!editor) return;

			// Take back the spaces the editor typed while the key repeated.
			takenBack = this.pendingDelete;
			this.pendingDelete = 0;
			for (let i = 0; i < takenBack; i++) editor.deleteBackward();

			// A previous stop may still be decoding its tail; its write would land
			// on top of the text this session is about to produce.
			await this.stopping;
			// A newer press now owns the buffer and will start its own session.
			if (id !== this.holdId) return;

			// Released before capture began: the tap must not vanish.
			if (!this.holding) {
				trace("begin: released while the previous stop finished, spaces restored");
				for (let i = 0; i < takenBack; i++) editor.typeSpace();
				return;
			}

			const stt = this.deps.getStt();
			const ui: SessionUi = {
				write: (text, cursorOffset, partialLength) => editor.writeAtCursor(text, cursorOffset, partialLength),
				status: (text) => this.deps.status(text),
				indicator: (state, filled, client) => this.deps.indicator(state, filled, client),
				notify: (message, level) => this.deps.notify(message, level),
			};
			const create = this.deps.createSession ?? ((engine, sessionUi) => new DictationSession(engine, sessionUi));
			const session = create(stt, ui);
			this.session = session;
			this.deps.onStart?.();
			await session.start(createRegion(editor.getText(), editor.insertionOffset()));

			// Cancelled while the device was opening: leave the buffer alone.
			if (id !== this.holdId) return;

			// Released while the capture device was opening: close it, and give the
			// space back if nothing was transcribed.
			if (!this.holding) {
				const committed = await session.stop();
				if (!committed) {
					for (let i = 0; i < takenBack; i++) editor.typeSpace();
				} else if (submit) {
					this.deps.onCommitted?.();
				}
			}
		} catch (error) {
			this.deps.notify(`Dictation: ${String(error)}`, "error");
			// Nothing was transcribed, so the deleted spaces come back.
			if (!this.session?.isActive()) {
				const editor = this.deps.getEditor();
				for (let i = 0; i < takenBack; i++) editor?.typeSpace();
			}
		} finally {
			this.starting = false;
			if (this.beginQueued) {
				this.beginQueued = false;
				if (this.holding && !this.session?.isActive()) this.requestBegin(this.holdId);
			}
		}
	}
}
