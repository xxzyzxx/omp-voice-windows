# Windows/OMP patches on pi-push-to-talk 0.6.3

The upstream package comes from npm (`git log`: commit 1 is unmodified). Every change is marked `[omp-windows patch]` in the source.

| File | Change | Why |
|---|---|---|
| `src/native.ts` (new), `src/capture.ts`, `src/stt.ts` | `decibri` and `sherpa-onnx-node` are imported by absolute file path. decibri gets its binding through its own `NAPI_RS_NATIVE_LIBRARY_PATH` hook. | Inside OMP 18.12.6 on Windows, a runtime `require()` of a bare package name from extension code fails. decibri reported "Cannot find native binding", which surfaced as "No microphone on this host". |
| `src/win-keystate.ts` (new), `src/hold.ts` | While a hold is live, the Space key is polled every 25 ms with `user32!GetAsyncKeyState` (via `bun:ffi`). The key coming up ends dictation. A hold also requires the key to be physically down. | OMP decodes win32-input-mode and drops key-up records, so no release ever reaches the extension. The physical-down check stops fast typing or unbracketed pastes (spaces under 150 ms apart) from being taken for a held key and having their spaces eaten. |
| `src/local-config.ts` (new) | User settings in `%USERPROFILE%\.omp\push-to-talk.json` (keys and voice-only mode). Capture always uses the Windows default input device, opened fresh for every dictation. | Switching microphones in Windows applies immediately, with no OMP setting. |
| `src/voice-only.ts`, `src/global-key.ts` (new), `src/hold.ts`, `src/editor.ts`, `src/win-keystate.ts`, `index.ts` | In-window dictation is a hold on a configurable key that types nothing (`"focusKey"`, default Right Ctrl). It is read from the OS, only while this OMP window has focus, and replaces hold-Space, which is no longer intercepted. `/voice-only` mode (off by default) adds a global hold key (default Right Ctrl too) that works while OMP is in the background. While the mode is on, every dictation that produced text is submitted as an Enter press. One OMP process owns the global key, via a loopback port lock on 47799. | Hold-Space typed spaces while it waited for key repeat. Voice-only gives one hold = one prompt, hands-free. |
| `src/hold.ts`, `index.ts` | Emits `process` event `omp-voice:dictation-start` when a dictation starts. | omp-talk-local stops speaking on it. |

On non-Windows platforms the OS key state is unavailable, so the upstream behaviour is unchanged there.
