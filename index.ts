import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DictationEditor } from "./src/editor.ts";
import { SpaceHold } from "./src/hold.ts";
import { ProbeEditor } from "./src/probe.ts";
import { listAudioSources, pinAudioSource } from "./src/source.ts";
import { parseHost, writeSetup } from "./src/setup.ts";
import { Stt } from "./src/stt.ts";
import { GlobalKey } from "./src/global-key.ts";
import { focusHoldMs, focusKey } from "./src/local-config.ts";
import { VoiceOnlyMode } from "./src/voice-only.ts";

type Ui = {
	notify: (message: string, level: "info" | "warning" | "error") => void;
	setStatus: (key: string, text: string | undefined) => void;
	theme: { fg: (color: "error", text: string) => string };
};

export default function dictationExtension(pi: ExtensionAPI): void {
	let ui: Ui | undefined;
	let editor: DictationEditor | undefined;
	let sttPromise: Promise<Stt> | undefined;

	const getStt = (): Promise<Stt> => {
		if (!sttPromise) {
			// Model progress has its own key: the listening indicator blinks on the
			// dictation key and must not overwrite a first-run download.
			sttPromise = Stt.create(undefined, (message) => ui?.setStatus("dictation-model", message)).then(
				(stt) => {
					ui?.setStatus("dictation-model", undefined);
					return stt;
				},
				(error: unknown) => {
					// Do not cache a failure: the next hold retries.
					sttPromise = undefined;
					ui?.setStatus("dictation-model", undefined);
					throw error;
				},
			);
		}
		return sttPromise;
	};

	const hold = new SpaceHold({
		getEditor: () => editor,
		getStt,
		notify: (message, level) => ui?.notify(message, level),
		status: (text) => ui?.setStatus("dictation", text),
		indicator: (state, filled, client) => {
			const circle = filled ? (ui?.theme.fg("error", "●") ?? "●") : "○";
			if (state === "loading") return `${circle} loading model`;
			return client ? `${circle} listening via ${client}` : `${circle} listening`;
		},
		// [omp-windows patch] Lets other extensions (omp-talk-local) stop speaking.
		onStart: () => process.emit("omp-voice:dictation-start" as never),
		// [omp-windows patch] Voice-only mode: one hold, one prompt.
		onCommitted: () => {
			if (voiceOnlyMode.active && editor && editor.focused !== false) editor.submitPrompt();
		},
	});
	const voiceOnlyMode = new VoiceOnlyMode(hold);
	const showMode = (): void => ui?.setStatus("voice-only", voiceOnlyMode.active ? "🎙 voice-only" : undefined);

	// [omp-windows patch] In-window dictation: hold a key that types nothing
	// (default Right Ctrl; "focusKey" in push-to-talk.json) instead of Space.
	const focusVk = focusKey();
	const focusHold =
		focusVk === undefined
			? undefined
			: new GlobalKey(
					focusVk,
					focusHoldMs(),
					{ onHold: (vk) => hold.beginGlobal(vk), onChord: () => hold.cancel() },
					true,
				);

	pi.registerCommand("voice-only", {
		description: "Toggle voice-only mode: global hold key (works in background) and auto-send after each dictation",
		handler: async (_args, ctx) => {
			if (voiceOnlyMode.active) {
				voiceOnlyMode.disable();
				ctx.ui.notify("Voice-only mode off: hold the dictation key in this window, press Enter to send", "info");
			} else {
				ctx.ui.notify(await voiceOnlyMode.enable(), "info");
			}
			showMode();
		},
	});

	// The microphone can be on the machine running the terminal instead of this
	// host. This prepares the command that sets that up from the other side.
	pi.registerCommand("dictation-setup", {
		description: "Generate the command that sets up dictation with your own microphone",
		handler: async (args, ctx) => {
			// Both the notice and the command offer the host, so the missing
			// argument never turns into a usage error the user cannot act on.
			const typed =
				args.trim() ||
				(await ctx.ui.input("SSH host that runs pi, e.g. the name you SSH to for this machine", "bluefin.local")) ||
				"";
			const host = parseHost(typed);
			if (!host) {
				ctx.ui.notify(`Dictation: "${typed.trim()}" is not an SSH host name`, "error");
				return;
			}
			try {
				const line = await writeSetup(host);
				pi.sendMessage({
					customType: "dictation-setup",
					content: `Run this once on the machine with the microphone, then reconnect to ${host}:\n\n\`\`\`sh\n${line}\n\`\`\`\n`,
					display: true,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Dictation: setup failed: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("dictation-source", {
		description: "List reachable microphones, or record from one of them",
		handler: async (args, ctx) => {
			const wanted = args.trim();
			const streams = await listAudioSources();
			if (!wanted) {
				if (streams.length === 0) {
					ctx.ui.notify("Dictation: no microphone stream is reachable", "warning");
					return;
				}
				const names = streams.map((stream) => stream.client).join(", ");
				ctx.ui.notify(`Dictation: recording from the first of ${names}; pick with /dictation-source <name>`, "info");
				return;
			}
			const match =
				streams.find((stream) => stream.client === wanted) ??
				streams.find((stream) => stream.target === wanted) ??
				streams.find((stream) => stream.target.endsWith(`:${wanted}`));
			if (!match) {
				ctx.ui.notify(`Dictation: no microphone stream named ${wanted}`, "warning");
				return;
			}
			pinAudioSource(match.target);
			ctx.ui.notify(`Dictation: recording from ${match.client}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ui = ctx.ui;

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			if (process.env.PI_DICTATION_PROBE) return new ProbeEditor(tui, theme, keybindings);
			editor = new DictationEditor(tui, theme, keybindings);
			return editor;
		});

		// [omp-windows patch] Space is no longer a dictation key; probe mode
		// (key logging only) starts no sessions.
		focusHold?.stop();
		if (!process.env.PI_DICTATION_PROBE) focusHold?.start();

		void voiceOnlyMode.restore().then((notice) => {
			if (notice) ui?.notify(notice, "info");
			showMode();
		});
	});

	// A submitted prompt clears the editor; an open session must not refill it
	// with a transcript written against the old buffer.
	pi.on("input", () => {
		hold.cancel();
	});

	pi.on("session_shutdown", () => {
		hold.cancel();
		voiceOnlyMode.disable(false);
		focusHold?.stop();
	});
}
