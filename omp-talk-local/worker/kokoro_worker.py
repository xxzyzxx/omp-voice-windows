"""Persistent local Kokoro TTS worker for omp-talk-local (Windows).

Protocol: one JSON object per line.
  stdin  -> {"cmd": "speak", "id": 1, "text": "...", "voice": "af_heart", "speed": 1.0}
            {"cmd": "stop"} | {"cmd": "voices"} | {"cmd": "quit"}
  stdout <- {"event": "ready", "load_ms": ..., "warm_ms": ...}
            {"event": "first_audio", "id": 1, "ms": ...}   # request received -> playback started
            {"event": "done", "id": 1} | {"event": "stopped"}
            {"event": "voices", "voices": [...]} | {"event": "error", "message": "..."}

The model stays loaded for the life of the process. Speech is synthesized one
sentence at a time and played through winmm waveOut (ctypes, stdlib only), so
the first sentence plays while the next is synthesized. EOF on stdin (the
parent exited or closed the pipe) shuts the worker down.
"""

from __future__ import annotations

import ctypes
import json
import os
import queue
import re
import sys
import threading
import time
from ctypes import wintypes

import numpy as np

SAMPLE_RATE = 24000
WHDR_DONE = 0x1
WAVE_MAPPER = 0xFFFFFFFF


class WAVEFORMATEX(ctypes.Structure):
    _fields_ = [
        ("wFormatTag", wintypes.WORD),
        ("nChannels", wintypes.WORD),
        ("nSamplesPerSec", wintypes.DWORD),
        ("nAvgBytesPerSec", wintypes.DWORD),
        ("nBlockAlign", wintypes.WORD),
        ("wBitsPerSample", wintypes.WORD),
        ("cbSize", wintypes.WORD),
    ]


class WAVEHDR(ctypes.Structure):
    _fields_ = [
        ("lpData", ctypes.c_void_p),
        ("dwBufferLength", wintypes.DWORD),
        ("dwBytesRecorded", wintypes.DWORD),
        ("dwUser", ctypes.c_size_t),
        ("dwFlags", wintypes.DWORD),
        ("dwLoops", wintypes.DWORD),
        ("lpNext", ctypes.c_void_p),
        ("reserved", ctypes.c_size_t),
    ]


_out_lock = threading.Lock()


def emit(**event) -> None:
    with _out_lock:
        sys.stdout.write(json.dumps(event) + "\n")
        sys.stdout.flush()


class Player:
    """Queues 16-bit mono PCM on the default output device via waveOut."""

    def __init__(self) -> None:
        self.winmm = ctypes.WinDLL("winmm")
        fmt = WAVEFORMATEX(1, 1, SAMPLE_RATE, SAMPLE_RATE * 2, 2, 16, 0)
        self.handle = wintypes.HANDLE()
        rc = self.winmm.waveOutOpen(ctypes.byref(self.handle), WAVE_MAPPER, ctypes.byref(fmt), 0, 0, 0)
        if rc != 0:
            raise OSError(f"waveOutOpen failed ({rc})")
        self.pending: list[tuple[WAVEHDR, ctypes.Array]] = []
        self.lock = threading.Lock()

    def write(self, pcm: bytes) -> None:
        buf = ctypes.create_string_buffer(pcm, len(pcm))
        hdr = WAVEHDR()
        hdr.lpData = ctypes.cast(buf, ctypes.c_void_p)
        hdr.dwBufferLength = len(pcm)
        size = ctypes.sizeof(WAVEHDR)
        with self.lock:
            self.winmm.waveOutPrepareHeader(self.handle, ctypes.byref(hdr), size)
            self.winmm.waveOutWrite(self.handle, ctypes.byref(hdr), size)
            self.pending.append((hdr, buf))

    def reap(self) -> int:
        """Release finished buffers; returns how many are still playing."""
        size = ctypes.sizeof(WAVEHDR)
        with self.lock:
            still = []
            for hdr, buf in self.pending:
                if hdr.dwFlags & WHDR_DONE:
                    self.winmm.waveOutUnprepareHeader(self.handle, ctypes.byref(hdr), size)
                else:
                    still.append((hdr, buf))
            self.pending = still
            return len(still)

    def reset(self) -> None:
        """Stop playback immediately; queued buffers are marked done."""
        self.winmm.waveOutReset(self.handle)
        self.reap()

    def close(self) -> None:
        self.reset()
        self.winmm.waveOutClose(self.handle)


SENTENCE = re.compile(r"(?<=[.!?\u2026])\s+")
CLAUSE = re.compile(r"(?<=[,;:\u2014])\s+")


def chunks(text: str) -> list[str]:
    """Sentences, with a long first sentence split at a clause boundary.

    Synthesis time grows with length, so a short first chunk starts playback
    sooner; later chunks are synthesized while earlier ones play.
    """
    sentences = [s for s in SENTENCE.split(text.strip()) if s]
    if sentences and len(sentences[0].split()) > 10:
        head, *rest = CLAUSE.split(sentences[0])
        while rest and len(head.split()) < 4:
            head = f"{head} {rest.pop(0)}"
        if rest:
            sentences[0:1] = [head, " ".join(rest)]
    return sentences


class Worker:
    def __init__(self, model: str, voices: str) -> None:
        t0 = time.perf_counter()
        from kokoro_onnx import Kokoro

        self.kokoro = Kokoro(model, voices)
        load_ms = (time.perf_counter() - t0) * 1000
        t1 = time.perf_counter()
        self.kokoro.create("Ready.", voice="af_heart", speed=1.0, lang="en-us")  # warm the ONNX session
        warm_ms = (time.perf_counter() - t1) * 1000
        self.player = Player()
        self.generation = 0
        self.jobs: queue.Queue = queue.Queue()
        self.audio: queue.Queue = queue.Queue()
        threading.Thread(target=self._synth_loop, daemon=True).start()
        threading.Thread(target=self._audio_loop, daemon=True).start()
        emit(event="ready", load_ms=round(load_ms), warm_ms=round(warm_ms), pid=os.getpid())

    def speak(self, job: dict) -> None:
        job["received"] = time.perf_counter()
        self.jobs.put((self.generation, job))

    def stop(self) -> None:
        self.generation += 1
        for q in (self.jobs, self.audio):
            while True:
                try:
                    q.get_nowait()
                except queue.Empty:
                    break
        self.player.reset()
        emit(event="stopped")

    def _synth_loop(self) -> None:
        while True:
            gen, job = self.jobs.get()
            if gen != self.generation:
                continue
            first = True
            try:
                for sentence in chunks(job["text"]):
                    if gen != self.generation:
                        break
                    samples, _rate = self.kokoro.create(
                        sentence,
                        voice=job.get("voice") or "af_heart",
                        speed=float(job.get("speed") or 1.0),
                        lang=job.get("lang") or "en-us",
                    )
                    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
                    self.audio.put((gen, job, pcm, first))
                    first = False
            except Exception as error:  # noqa: BLE001 - reported to the extension
                emit(event="error", id=job.get("id"), message=str(error))
            self.audio.put((gen, job, None, False))

    def _audio_loop(self) -> None:
        open_jobs: list[dict] = []
        open_gen = self.generation
        while True:
            try:
                gen, job, pcm, first = self.audio.get(timeout=0.02)
                if gen == self.generation:
                    if pcm is None:
                        job["synth_done"] = True
                        if job not in open_jobs:
                            open_jobs.append(job)
                    else:
                        self.player.write(pcm)
                        if first:
                            emit(event="first_audio", id=job.get("id"), ms=round((time.perf_counter() - job["received"]) * 1000))
                        if job not in open_jobs:
                            open_jobs.append(job)
            except queue.Empty:
                pass
            playing = self.player.reap()
            if open_gen != self.generation:  # stopped: forget interrupted jobs
                open_jobs.clear()
                open_gen = self.generation
            if playing == 0 and open_jobs and all(j.get("synth_done") for j in open_jobs):
                for j in open_jobs:
                    emit(event="done", id=j.get("id"))
                open_jobs.clear()

    def voices(self) -> None:
        emit(event="voices", voices=sorted(self.kokoro.get_voices()))


def main() -> None:
    if len(sys.argv) != 3:
        sys.stderr.write("usage: kokoro_worker.py <kokoro-v1.0.onnx> <voices-v1.0.bin>\n")
        sys.exit(2)
    try:
        worker = Worker(sys.argv[1], sys.argv[2])
    except Exception as error:  # noqa: BLE001
        emit(event="error", message=f"startup failed: {error}")
        sys.exit(1)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            cmd = msg.get("cmd")
            if cmd == "speak":
                worker.speak(msg)
            elif cmd == "stop":
                worker.stop()
            elif cmd == "voices":
                worker.voices()
            elif cmd == "quit":
                break
        except Exception as error:  # noqa: BLE001
            emit(event="error", message=str(error))
    worker.player.close()
    os._exit(0)


if __name__ == "__main__":
    main()
