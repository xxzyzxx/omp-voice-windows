# omp-talk-local

Speaks the `<voice>…</voice>` summary at the end of each OMP reply, using a local Kokoro model on Windows. Setup, commands and config: see `..\README.md`.

## Credit

This is a fork of [`@swairshah/pi-talk`](https://github.com/swairshah/Loqui) by Swair Shah (MIT). The following parts carry over: the injected system prompt that teaches the agent to emit `<voice>` tags (reworded so the tag comes last and is written for listening), `<voice>` extraction, and the succinct/verbose style toggle.

Removed: the Loqui.app TTS server and broker (`127.0.0.1:18080/18081`), the macOS Cmd+. shortcut, the inbox watcher and the status broadcasting.

Added:

- `worker/kokoro_worker.py`: a hidden, persistent kokoro-onnx process. It reads JSON lines on stdin, plays audio with winmm `waveOut` (stdlib `ctypes`), and splits the text into sentences, with a long first sentence split at a clause, so playback starts early.
- Stop speech on prompt submit, on a push-to-talk hold, and with Alt+S.
- Settings persisted in `%USERPROFILE%\.omp\talk-local.json`.
- The worker exits when OMP closes its stdin, including when OMP is killed.

License: MIT (see `LICENSE`).
