"""Word-level transcription for Clipper captions.

usage: python transcribe.py <audio.wav> <out.json> [language|auto]
Tries the GPU first (CUDA, int8), falls back to CPU automatically.
Models are cached in tools/models (downloaded once on first use).
"""
import glob
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))

# Make the pip-installed CUDA libraries (cuBLAS / cuDNN) visible on Windows
for d in glob.glob(os.path.join(HERE, "venv", "Lib", "site-packages", "nvidia", "*", "bin")):
    try:
        os.add_dll_directory(d)
    except Exception:
        pass
    os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")

from faster_whisper import WhisperModel  # noqa: E402

GPU_MODEL = os.environ.get("CLIPPER_WHISPER_MODEL", "small")
CPU_MODEL = os.environ.get("CLIPPER_WHISPER_CPU_MODEL", "base")
MODELS_DIR = os.path.join(HERE, "models")
# Clipper runs this in the background: keep it to a couple of CPU threads so playback never stutters
CPU_THREADS = max(1, int(os.environ.get("CLIPPER_WHISPER_THREADS", "2") or 2))


def load_wav(path):
    # Clipper always writes 16 kHz mono 16-bit PCM, so no decoder (PyAV) is needed
    import wave
    import numpy as np
    with wave.open(path, "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("expected 16kHz mono s16 wav")
        data = w.readframes(w.getnframes())
    return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0


def run(wav, lang, device, compute_type, model_name):
    model = WhisperModel(model_name, device=device, compute_type=compute_type, download_root=MODELS_DIR,
                         cpu_threads=CPU_THREADS, num_workers=1)
    segments, info = model.transcribe(
        load_wav(wav),
        language=lang,
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
        condition_on_previous_text=False,
    )
    words = []
    for seg in segments:  # generator: errors (e.g. missing CUDA dlls) surface here
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                words.append({"start": round(w.start, 3), "end": round(w.end, 3), "word": text, "p": round(w.probability, 3)})
    return info.language, words


def main():
    wav, out = sys.argv[1], sys.argv[2]
    lang = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] not in ("", "auto") else None
    attempts = [("cuda", "int8_float32", GPU_MODEL), ("cuda", "int8", GPU_MODEL), ("cpu", "int8", CPU_MODEL)]
    # CLIPPER_WHISPER_DEVICE=cpu: keep the GPU free for stream playback/recording
    if os.environ.get("CLIPPER_WHISPER_DEVICE", "").lower() == "cpu":
        attempts = [("cpu", "int8", CPU_MODEL)]
    last = None
    for device, ct, name in attempts:
        t0 = time.time()
        try:
            language, words = run(wav, lang, device, ct, name)
            with open(out, "w", encoding="utf-8") as f:
                json.dump({"device": device, "model": name, "language": language, "words": words}, f, ensure_ascii=False)
            print(f"OK device={device} model={name} lang={language} words={len(words)} secs={time.time() - t0:.1f}")
            return 0
        except Exception as e:  # try the next option
            last = e
            print(f"fallback: {device}/{ct} failed: {e}", file=sys.stderr)
    print(f"FAILED: {last}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
