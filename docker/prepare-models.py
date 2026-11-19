"""Reuse complete local models in the build context, or install missing weights."""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "models" / "whisper-th-small"


def complete_whisper():
    try:
        manifest = json.loads((MODEL / "manifest.json").read_text())
        hashes = manifest["files"]
        required = ["model.bin", "config.json", "tokenizer.json"]
        vocabulary = "vocabulary.txt" if (MODEL / "vocabulary.txt").is_file() else "vocabulary.json"
        for name in required:
            with (MODEL / name).open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != hashes.get(name):
                    return False
        if not (MODEL / vocabulary).stat().st_size:
            return False
        if vocabulary in hashes:
            with (MODEL / vocabulary).open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != hashes[vocabulary]:
                    return False
        elif vocabulary.endswith(".json"):
            # Older project manifests omitted the JSON vocabulary checksum.
            # The following actual Recognizer load also validates this file.
            if not json.loads((MODEL / vocabulary).read_text()):
                return False
        return True
    except (OSError, ValueError, KeyError, TypeError):
        return False


if not complete_whisper():
    subprocess.run([sys.executable, str(ROOT / "scripts/download-local-asr.py")], check=True)
subprocess.run([sys.executable, str(ROOT / "scripts/download-browser-asr.py")], check=True)
print("Server and browser speech models are ready for the image", flush=True)
