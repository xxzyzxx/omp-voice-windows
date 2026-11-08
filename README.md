# Local voice loop for OMP on Windows

Talk to OMP (oh-my-pi) and hear it answer back, entirely on your own machine. You don't need API keys, and nothing is sent to the cloud.

| Extension | What it does | Origin |
|---|---|---|
| `pi-push-to-talk` | Hold **Right Ctrl** (configurable), speak, release: local Whisper (sherpa-onnx) types the transcript into the prompt. Optional `/voice-only` mode makes the key work from any window and sends the prompt by itself. | [`pi-push-to-talk`](https://www.npmjs.com/package/pi-push-to-talk) 0.6.3 by sqwxl (MIT), with Windows/OMP patches. See [`pi-push-to-talk/PATCHES.md`](pi-push-to-talk/PATCHES.md). |
| `omp-talk-local` | Has the agent end every reply with a short spoken `<voice>…</voice>` summary, and speaks only that part with a local Kokoro model. | Rewrite of [`@swairshah/pi-talk`](https://github.com/swairshah/Loqui) by Swair Shah (MIT). The macOS Loqui app is replaced with a local Kokoro worker. |

Dictation always uses the **Windows default recording device**, and speech plays on the **Windows default playback device**. To switch microphones or speakers, change the default in Windows Sound settings. OMP picks up the change on the next dictation or reply.

## Requirements

- Windows 10 or 11, x64.
- OMP 18.12 or newer, run from a console window. Tested in PowerShell 7 under the classic console host. Windows Terminal should work the same way, but hasn't been tested.
- [uv](https://docs.astral.sh/uv/) for the Kokoro Python environment (`winget install astral-sh.uv`). uv downloads its own Python, so no system Python is needed.
- `git`, to clone this repository.

## Install (PowerShell 7 or Windows PowerShell 5.1)

```powershell
git clone https://github.com/xxzyzxx/omp-voice-windows.git "$env:USERPROFILE\omp-voice"
$root = "$env:USERPROFILE\omp-voice"

# 1. Kokoro TTS: a dedicated venv plus model files (about 350 MB, nothing system-wide)
$tl = "$env:USERPROFILE\.omp\talk-local"
uv venv --python 3.12 "$tl\venv"
uv pip install --python "$tl\venv\Scripts\python.exe" kokoro-onnx
New-Item -ItemType Directory -Force "$tl\models" | Out-Null
$rel = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0'
curl.exe -L -o "$tl\models\kokoro-v1.0.onnx" "$rel/kokoro-v1.0.onnx"
curl.exe -L -o "$tl\models\voices-v1.0.bin"  "$rel/voices-v1.0.bin"

# 2. Native dependencies of push-to-talk (installed by the Bun runtime embedded in omp)
Set-Location "$root\pi-push-to-talk"
$env:BUN_BE_BUN = '1'; omp install --production; Remove-Item Env:BUN_BE_BUN

# 3. Register both extensions with OMP
omp plugin link "$root\pi-push-to-talk"
omp plugin link "$root\omp-talk-local"

# 4. OMP's built-in speech-to-text binds Space and also uses the microphone; turn it off
omp config set stt.enabled false
```

Use `curl.exe`, not `curl`: in Windows PowerShell 5.1, `curl` is an alias for `Invoke-WebRequest`. The commands avoid `&&`, which 5.1 doesn't have.

The first dictation downloads Whisper base (about 200 MB) to `%USERPROFILE%\.pi\models\whisper-base`. The Kokoro worker starts with the first prompt of a session and stays loaded until OMP exits.

To check that both extensions load, run `omp models ls`. Load errors go to stderr as `Failed to load extension: …`, and also to `%USERPROFILE%\.omp\logs\`.

## Use

| Action | Result |
|---|---|
| Hold **Right Ctrl** (OMP window focused), speak, release | The transcript appears at the cursor. Press Enter to send it. Starting a dictation stops any speech that is playing. |
| Enter | Sends the prompt and stops speech. |
| **Alt+S** | Stops speech (OMP window focused; it is an OMP shortcut, so it only arrives as terminal input). In voice-only mode, briefly holding Right Ctrl from any window also stops speech: it starts a dictation, and an empty dictation sends nothing. |
| `/tts` | Turns spoken summaries on or off. Off also removes the `<voice>` instructions from the system prompt. |
| `/tts-stop` | Stops speech. |
| `/tts-voice` / `/tts-voice bf_emma` | Lists voices / sets the voice (`af_heart`, `am_michael`, `bf_emma`, `bm_george`, …). |
| `/tts-speed 1.2` | Sets the speaking rate, 0.5–2.0. |
| `/tts-style` | Switches between succinct (1–2 sentences) and verbose (2–3 sentences, more conversational). |
| `/tts-say <text>` | Speaks any text. |
| `/tts-status` | Shows settings, the worker process, model load time, and the last time to first audio. |
| `/voice-only` | Turns voice-only mode on or off (saved between sessions). |

### Voice-only mode

One hold sends one prompt, from any window:

- Hold Right Ctrl, speak, release. The transcript is sent as if you had pressed Enter. If the agent is busy, it goes in as a steer, like pressing Enter would.
- It works while OMP is in the background. The key is read from Windows' key state, not intercepted, and holding Right Ctrl alone does nothing in other apps.
- While the mode is on, dictations from the in-window key are sent automatically too.
- Only one OMP window can own the global key: the first one to enable the mode. Other windows tell you so.

## Configuration

| File | Contents |
|---|---|
| `%USERPROFILE%\.omp\push-to-talk.json` | `focusKey` (in-window key, default `RightCtrl`, or `"off"`), `focusHoldMs` (default 150), `voiceOnly`, `globalKey` (voice-only key, default `RightCtrl`, or `"off"`), `globalHoldMs` (default 250). Key names: `RightCtrl`, `RightAlt`, `RightShift`, `CapsLock`, `ScrollLock`, `Pause`, `F13`–`F24`, `XButton1`/`XButton2` (mouse side buttons), or any Windows virtual-key number. |
| `%USERPROFILE%\.omp\talk-local.json` | Written by the `/tts*` commands: `enabled`, `voice`, `speed`, `style`, `fallbackFirstSentence` (default `false`; when `true`, a final reply without `<voice>` has its first sentence spoken), and the `python`, `model` and `voices` paths. |
| `%USERPROFILE%\.omp\talk-local\` | Kokoro venv and model files. |
| `%USERPROFILE%\.pi\models\whisper-base\` | Whisper model. |

Debug logs, enabled before starting `omp`:

```powershell
$env:PI_DICTATION_DEBUG = '1'   # dictation events -> $env:TEMP\pi-dictation.log
$env:OMP_TALK_DEBUG = '1'       # TTS worker events and timings -> $env:TEMP\omp-talk-local.log
```

## Disable or remove

```powershell
omp plugin disable pi-push-to-talk     # omp plugin enable … to turn it back on
omp plugin disable omp-talk-local
omp plugin uninstall omp-talk-local    # removes the link only; the files stay
```

Restart OMP after enabling or disabling an extension. To silence speech without unloading anything, use `/tts`.

## How it works on Windows

- OMP reads the console in win32-input-mode and drops key-up events, and keys like Right Ctrl produce no terminal input at all. Dictation keys are therefore read from Windows (`GetAsyncKeyState`). The in-window key also checks that the OMP console window has focus (`GetForegroundWindow`). The terminal needs no configuration.
- Inside OMP on Windows, extensions can't `require()` native packages by bare name. The push-to-talk patches load `decibri` and `sherpa-onnx-node` by file path instead.
- The Kokoro worker is a hidden Python process that keeps the model in memory. It synthesizes one sentence at a time and plays through `winmm` (`ctypes`, no extra packages). It exits when OMP closes, even if OMP is killed.
- Alt+S isn't bound by OMP, the console host, or PSReadLine.

## License

MIT for both extensions. Original authors are credited in each package's `LICENSE`.
