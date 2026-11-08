/**
 * omp-talk-local: speak the <voice> part of OMP replies with a local Kokoro model.
 *
 * Derived from @swairshah/pi-talk (MIT, Swair Shah). Kept: the system prompt
 * that teaches the agent to emit <voice> tags, <voice> extraction, and the
 * succinct/verbose style toggle. Replaced: the Loqui.app broker, the macOS
 * Cmd+. shortcut, the inbox watcher and status broadcasting. Speech now comes
 * from a hidden, persistent Python worker (kokoro-onnx) that plays through
 * Windows waveOut.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const HOME_DIR = path.join(os.homedir(), ".omp", "talk-local");
const SETTINGS_FILE = path.join(os.homedir(), ".omp", "talk-local.json");
const WORKER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker", "kokoro_worker.py");
/** `$env:OMP_TALK_DEBUG='1'` appends every worker event (with timings) here. */
const DEBUG_LOG = process.env.OMP_TALK_DEBUG ? path.join(os.tmpdir(), "omp-talk-local.log") : undefined;

type Style = "succinct" | "verbose";

type Settings = {
	enabled: boolean;
	voice: string;
	speed: number;
	style: Style;
	/** Speak the first sentence of a final reply that has no <voice> tag. */
	fallbackFirstSentence: boolean;
	python: string;
	model: string;
	voices: string;
};

const DEFAULTS: Settings = {
	enabled: true,
	voice: "af_heart",
	speed: 1.0,
	style: "succinct",
	fallbackFirstSentence: false,
	python: path.join(HOME_DIR, "venv", "Scripts", "python.exe"),
	model: path.join(HOME_DIR, "models", "kokoro-v1.0.onnx"),
	voices: path.join(HOME_DIR, "models", "voices-v1.0.bin"),
};

function loadSettings(): Settings {
	try {
		return { ...DEFAULTS, ...(JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as Partial<Settings>) };
	} catch {
		return { ...DEFAULTS };
	}
}

function saveSettings(settings: Settings): void {
	fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
	fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
}

const VOICE_RULES = `
The text outside <voice> tags shows on screen as usual; only the <voice> text is read aloud by a text-to-speech engine, so write it for the ear:
- Put exactly one <voice>...</voice> block at the very end of your final reply in a turn, after everything else. Never put it in messages that precede tool calls, and never at the start.
- Plain spoken sentences only: no markdown, code, file paths, URLs, commands, version strings, lists, emoji, or other tags inside it.
- Talk to the user the way a colleague answers out loud: contractions, natural rhythm, say "about two seconds" rather than "1.98 s".
- Do not read the on-screen reply back or restate its first line. Give the takeaway: what happened, what it means, or what you need from the user. If you are asking the user something, ask it here too.
- Refer to code and files by what they do ("the config loader"), not by name or path.`;

const VOICE_PROMPTS: Record<Style, string> = {
	succinct: `
## Voice summary
End every reply with a short spoken version wrapped in <voice> tags: one or two sentences.
${VOICE_RULES}

Examples:
<voice>Fixed it. The test was failing because the cache never got cleared between runs.</voice>
<voice>I need one decision from you: should I keep the old endpoint around for a release, or remove it now?</voice>
`,
	verbose: `
## Voice summary
End every reply with a conversational spoken version wrapped in <voice> tags: two or three sentences.
${VOICE_RULES}
- You can add a bit of reasoning or a suggested next step, as you would when talking it through.

Examples:
<voice>Okay, that's working now. The real problem was the cache never getting cleared between test runs, so each run saw stale data. If you want, I can add a test so that doesn't sneak back in.</voice>
`,
};

/** Spoken form: drop markdown, code, URLs and paths that sound bad aloud. */
function speakable(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\b(?:https?|ftp|file):\/\/\S+/gi, " ")
		.replace(/\bwww\.\S+/gi, " ")
		.replace(/(?:[A-Za-z]:)?(?:[\\/][\w.-]+){2,}[\\/]?/g, " ")
		.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
		.replace(/^\s*#{1,6}\s+/gm, "")
		.replace(/^\s*>\s?/gm, "")
		.replace(/[*_~|#]+/g, " ")
		.replace(/\s+/g, " ")
		.replace(/\s+([,.!?;:])/g, "$1")
		.trim();
}

function voiceBlocks(text: string): string[] {
	return [...text.matchAll(/<voice>([\s\S]*?)<\/voice>/gi)].map((match) => match[1] ?? "");
}

type WorkerEvent = { event: string; id?: number; ms?: number; message?: string; voices?: string[]; load_ms?: number; warm_ms?: number; pid?: number };

/** The hidden, warm Kokoro process. */
class KokoroWorker {
	#child: ChildProcessWithoutNullStreams | undefined;
	#ready: Promise<void> | undefined;
	#nextId = 1;
	#stderr = "";
	#voices: string[] | undefined;
	#voiceWaiters: Array<(voices: string[]) => void> = [];
	readonly stats: { loadMs?: number; warmMs?: number; firstAudioMs?: number; pid?: number } = {};
	onError: (message: string) => void = () => {};

	get running(): boolean {
		return this.#child !== undefined && this.#child.exitCode === null;
	}

	start(settings: Settings): Promise<void> {
		if (this.#ready && this.running) return this.#ready;
		for (const [label, file] of [["python", settings.python], ["model", settings.model], ["voices", settings.voices]]) {
			if (!fs.existsSync(file)) return Promise.reject(new Error(`${label} not found: ${file}`));
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#ready = promise;
		this.#stderr = "";
		const child = spawn(settings.python, ["-u", WORKER_SCRIPT, settings.model, settings.voices], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			env: { ...process.env, PYTHONIOENCODING: "utf-8" },
		});
		this.#child = child;
		let buffered = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffered += chunk;
			for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
				const line = buffered.slice(0, end).trim();
				buffered = buffered.slice(end + 1);
				if (!line) continue;
				if (DEBUG_LOG) {
					try {
						fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`);
					} catch {}
				}
				let event: WorkerEvent;
				try {
					event = JSON.parse(line) as WorkerEvent;
				} catch {
					continue;
				}
				if (event.event === "ready") {
					this.stats.loadMs = event.load_ms;
					this.stats.warmMs = event.warm_ms;
					this.stats.pid = event.pid;
					resolve();
				} else if (event.event === "first_audio") {
					this.stats.firstAudioMs = event.ms;
				} else if (event.event === "voices") {
					this.#voices = event.voices ?? [];
					for (const waiter of this.#voiceWaiters.splice(0)) waiter(this.#voices);
				} else if (event.event === "error") {
					this.onError(event.message ?? "unknown worker error");
				}
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.#stderr = (this.#stderr + chunk).slice(-2000);
		});
		child.on("error", (error) => reject(error));
		child.on("exit", (code) => {
			if (this.#child === child) this.#child = undefined;
			reject(new Error(`Kokoro worker exited (${code}) ${this.#stderr.trim().split("\n").pop() ?? ""}`));
		});
		child.stdin.on("error", () => {});
		return promise;
	}

	#send(message: Record<string, unknown>): void {
		if (this.running) this.#child?.stdin.write(`${JSON.stringify(message)}\n`);
	}

	async speak(settings: Settings, text: string): Promise<void> {
		await this.start(settings);
		this.#send({ cmd: "speak", id: this.#nextId++, text, voice: settings.voice, speed: settings.speed });
	}

	stop(): void {
		this.#send({ cmd: "stop" });
	}

	async voices(settings: Settings): Promise<string[]> {
		if (this.#voices) return this.#voices;
		await this.start(settings);
		const { promise, resolve } = Promise.withResolvers<string[]>();
		this.#voiceWaiters.push(resolve);
		this.#send({ cmd: "voices" });
		return promise;
	}

	/** Ask the worker to exit, then make sure it did. */
	shutdown(): void {
		const child = this.#child;
		if (!child) return;
		this.#child = undefined;
		this.#ready = undefined;
		try {
			child.stdin.write(`${JSON.stringify({ cmd: "quit" })}\n`);
			child.stdin.end();
		} catch {}
		const timer = setTimeout(() => child.kill(), 1000);
		timer.unref?.();
		child.once("exit", () => clearTimeout(timer));
	}

	/** Synchronous last resort when the host process is exiting. */
	kill(): void {
		this.#child?.kill();
		this.#child = undefined;
	}
}

type Ctx = {
	hasUI: boolean;
	agent?: { kind: "main" | "sub" };
	ui: {
		notify(message: string, level: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
	};
};

export default function ompTalkLocal(pi: ExtensionAPI): void {
	const settings = loadSettings();
	const worker = new KokoroWorker();
	let ui: Ctx["ui"] | undefined;
	const exitHook = (): void => worker.kill();
	process.once("exit", exitHook);
	// pi-push-to-talk (omp-windows patch) emits this when a dictation starts,
	// from Space in the prompt or voice-only mode's global key.
	const dictationHook = (): void => worker.stop();
	process.on("omp-voice:dictation-start" as never, dictationHook);

	worker.onError = (message) => ui?.notify(`TTS: ${message}`, "warning");

	const isMain = (ctx: Ctx): boolean => ctx.agent?.kind !== "sub";

	const updateStatus = (): void => {
		if (!ui) return;
		if (!settings.enabled) ui.setStatus("tts", "🔇 tts off");
		else ui.setStatus("tts", settings.style === "verbose" ? "🔊+" : "🔊");
	};

	const persist = (): void => {
		try {
			saveSettings(settings);
		} catch (error) {
			ui?.notify(`TTS: could not save ${SETTINGS_FILE}: ${String(error)}`, "warning");
		}
	};

	const say = (text: string): void => {
		const clean = speakable(text);
		if (!clean) return;
		worker.speak(settings, clean).catch((error: unknown) => {
			ui?.notify(`TTS: ${error instanceof Error ? error.message : String(error)}`, "error");
		});
	};

	pi.on("session_start", (_event, ctx: Ctx) => {
		if (!ctx.hasUI || !isMain(ctx)) return;
		ui = ctx.ui;
		updateStatus();
	});

	// A new prompt makes the previous answer moot.
	pi.on("input", (_event, ctx: Ctx) => {
		if (isMain(ctx)) worker.stop();
	});

	pi.on("before_agent_start", (event, ctx: Ctx) => {
		if (!settings.enabled || !isMain(ctx)) return;
		// Warm the worker while the model thinks, so the reply speaks at once.
		worker.start(settings).catch((error: unknown) => {
			ui?.notify(`TTS: ${error instanceof Error ? error.message : String(error)}`, "error");
		});
		const prompt = VOICE_PROMPTS[settings.style];
		const base = event.systemPrompt as string | string[];
		return { systemPrompt: Array.isArray(base) ? [...base, prompt] : `${base}\n${prompt}` };
	});

	pi.on("message_end", (event, ctx: Ctx) => {
		if (!settings.enabled || !isMain(ctx)) return;
		const message = event.message as { role: string; content: Array<{ type: string; text?: string }> };
		if (message.role !== "assistant") return;
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n");
		const blocks = voiceBlocks(text);
		if (blocks.length > 0) {
			say(blocks.join(" "));
			return;
		}
		const final = !message.content.some((block) => block.type === "toolCall");
		if (settings.fallbackFirstSentence && final) {
			const first = speakable(text).match(/^.*?[.!?](?=\s|$)/)?.[0];
			if (first) say(first);
		}
	});

	pi.on("session_shutdown", () => {
		process.off("omp-voice:dictation-start" as never, dictationHook);
		worker.shutdown();
		process.off("exit", exitHook);
	});

	pi.registerShortcut("alt+s", {
		description: "Stop speech (omp-talk-local)",
		handler: async () => {
			worker.stop();
		},
	});

	pi.registerCommand("tts", {
		description: "Toggle spoken <voice> summaries on/off (also stops the voice prompt)",
		handler: async (_args, ctx) => {
			settings.enabled = !settings.enabled;
			if (!settings.enabled) worker.stop();
			persist();
			updateStatus();
			ctx.ui.notify(settings.enabled ? "TTS on: replies end with a spoken summary" : "TTS off", "info");
		},
	});

	pi.registerCommand("tts-stop", {
		description: "Stop current speech (shortcut: Alt+S)",
		handler: async () => {
			worker.stop();
		},
	});

	pi.registerCommand("tts-voice", {
		description: "Show or set the Kokoro voice, e.g. /tts-voice af_heart",
		handler: async (args, ctx) => {
			const wanted = args.trim().toLowerCase();
			let voices: string[] = [];
			try {
				voices = await worker.voices(settings);
			} catch (error) {
				ctx.ui.notify(`TTS: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			if (!wanted) {
				ctx.ui.notify(`Voice: ${settings.voice}\nAvailable: ${voices.join(", ")}`, "info");
				return;
			}
			if (!voices.includes(wanted)) {
				ctx.ui.notify(`Unknown voice "${wanted}". Available: ${voices.join(", ")}`, "warning");
				return;
			}
			settings.voice = wanted;
			persist();
			ctx.ui.notify(`Voice: ${wanted}`, "info");
		},
	});

	pi.registerCommand("tts-speed", {
		description: "Show or set speaking rate, 0.5-2.0 (1 = normal)",
		handler: async (args, ctx) => {
			const value = Number.parseFloat(args.trim());
			if (!args.trim()) {
				ctx.ui.notify(`Speed: ${settings.speed}`, "info");
				return;
			}
			if (!Number.isFinite(value) || value < 0.5 || value > 2) {
				ctx.ui.notify("Usage: /tts-speed <0.5-2.0>", "warning");
				return;
			}
			settings.speed = Math.round(value * 100) / 100;
			persist();
			ctx.ui.notify(`Speed: ${settings.speed}`, "info");
		},
	});

	pi.registerCommand("tts-style", {
		description: "Toggle voice style: succinct (1-2 sentences) or verbose (2-3, more conversational)",
		handler: async (_args, ctx) => {
			settings.style = settings.style === "succinct" ? "verbose" : "succinct";
			persist();
			updateStatus();
			ctx.ui.notify(`Voice style: ${settings.style}`, "info");
		},
	});

	pi.registerCommand("tts-say", {
		description: "Speak arbitrary text",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /tts-say <text>", "warning");
				return;
			}
			worker.stop();
			say(args);
		},
	});

	pi.registerCommand("tts-status", {
		description: "Show TTS settings and worker state",
		handler: async (_args, ctx) => {
			const { loadMs, warmMs, firstAudioMs, pid } = worker.stats;
			ctx.ui.notify(
				[
					`TTS: ${settings.enabled ? "on" : "off"} | voice ${settings.voice} | speed ${settings.speed} | style ${settings.style} | first-sentence fallback ${settings.fallbackFirstSentence ? "on" : "off"}`,
					`Worker: ${worker.running ? `running (pid ${pid ?? "?"})` : "not started"}${loadMs !== undefined ? ` | model load ${loadMs} ms, warm-up ${warmMs} ms` : ""}${firstAudioMs !== undefined ? ` | last time-to-first-audio ${firstAudioMs} ms` : ""}`,
					`Settings: ${SETTINGS_FILE}`,
				].join("\n"),
				"info",
			);
		},
	});
}
