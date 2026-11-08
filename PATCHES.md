# Windows/OMP patches on pi-push-to-talk 0.6.3

The upstream package comes from npm (`git log`: commit 1 is unmodified). Every change is marked `[omp-windows patch]` in the source.

| File | Change | Why |
|---|---|---|
| `src/native.ts` (new), `src/capture.ts`, `src/stt.ts` | `decibri` and `sherpa-onnx-node` are imported by absolute file path. decibri gets its binding through its own `NAPI_RS_NATIVE_LIBRARY_PATH` hook. | Inside OMP 18.12.6 on Windows, a runtime `require()` of a bare package name from extension code fails. decibri reported "Cannot find native binding", which surfaced as "No microphone on this host". |
| `src/win-keystate.ts` (new), `src/hold.ts` | While a hold is live, the Space key is polled every 25 ms with `user32!GetAsyncKeyState` (via `bun:ffi`). The key coming up ends dictation. A hold also requires the key to be physically down. | OMP decodes win32-input-mode and drops key-up records, so no release ever reaches the extension. The physical-down check stops fast typing or unbracketed pastes (spaces under 150 ms apart) from being taken for a held key and having their spaces eaten. |
| `src/local-config.ts` (new), `src/capture.ts` | The capture device comes from `%USERPROFILE%\.omp\push-to-talk.json` `{ "device": "<name substring>" }` or from `PI_DICTATION_DEVICE`. | The Windows default input here is a virtual cable that records silence. |
| `package.json` | Adds `omp.extensions` (the `pi.extensions` fallback is kept). | Native OMP manifest key. |

On non-Windows platforms the OS key state is unavailable, so the upstream behaviour is unchanged there.
