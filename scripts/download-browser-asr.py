"""Install and verify the public Engi browser speech model once on the host."""
import hashlib
import json
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "models" / "typhoon-q4-v1"
REPO = "saksornr/typhoon-asr-realtime-webgpu-q4"
REVISION = "2c547288276638a4823d8a108c81df9771f89c2a"
FILES = {
    "encoder.q4.onnx": (136166126, "e533ac52828c4923ca77605c5cb867d46d375da74c326bd23f6e6ee0ec86d34b"),
    "predictor.fp32.onnx": (18375980, "38ce92a5222cc9161b14b340cba657d4b4b1833bd4f7e6daf3bf7a02969ba735"),
    "joint.fp32.onnx": (8209157, "7f1931c17a9b82dfdc488c8b1a5be15f9cc8b0db7e4d8b8de8b462fafb41e353"),
    "frontend.json": (245854, "ed4b0319ac8b8091395216d37c5992edd22fdbd1e5023c8c27057583a948dc18"),
    "tokenizer.json": (40412, "a83b8bb01d9bc328ff2cdc6eccb32586094d10a664674d146963194d6e687aad"),
}


def matches(path, size, digest):
    if not path.is_file() or path.stat().st_size != size:
        return False
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == digest


def download(path, size, digest):
    url = f"https://huggingface.co/{REPO}/resolve/{REVISION}/{path.name}"
    with tempfile.NamedTemporaryFile(dir=TARGET, prefix=path.name, suffix=".part", delete=False) as stream:
        staged = Path(stream.name)
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                remaining = size
                while chunk := response.read(min(remaining + 1, 1024 * 1024)):
                    remaining -= len(chunk)
                    if remaining < 0:
                        raise ValueError(f"Unexpected download size for {path.name}")
                    stream.write(chunk)
            stream.close()
            if not matches(staged, size, digest):
                raise ValueError(f"Checksum mismatch for {path.name}")
            staged.replace(path)
        finally:
            stream.close()
            staged.unlink(missing_ok=True)


def main():
    TARGET.mkdir(parents=True, exist_ok=True)
    manifest = TARGET / "manifest.json"
    missing = [name for name, checks in FILES.items() if not matches(TARGET / name, *checks)]
    if missing:
        manifest.unlink(missing_ok=True)
    for name in missing:
        print(f"[download] {name}", flush=True)
        download(TARGET / name, *FILES[name])
    metadata = {
        "id": TARGET.name,
        "schemaVersion": 1,
        "source": f"https://huggingface.co/{REPO}/tree/{REVISION}",
        "upstream": "https://huggingface.co/typhoon-ai/typhoon-asr-realtime",
        "license": "https://creativecommons.org/licenses/by/4.0/",
        "files": {name: {"bytes": size, "sha256": digest} for name, (size, digest) in FILES.items()},
    }
    with tempfile.NamedTemporaryFile(dir=TARGET, prefix="manifest", suffix=".part",
                                     mode="w", encoding="utf-8", delete=False) as stream:
        staged = Path(stream.name)
        try:
            json.dump(metadata, stream, indent=2)
            stream.write("\n")
            stream.close()
            staged.replace(manifest)
        finally:
            stream.close()
            staged.unlink(missing_ok=True)
    print("[ready] Engi browser model verified")


if __name__ == "__main__":
    main()
