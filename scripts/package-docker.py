"""Export a portable Docker bundle for a Windows x64 Linux-container host."""
import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IMAGES = {"web": "bimclub-web:local", "node-red": "bimclub-node-red:local"}
SEED_FILES = {
    "data/login-account.json": "seed/web/login-account.json",
    "data/ac-schedules.json": "seed/web/ac-schedules.json",
    "data/ac-occupancy.json": "seed/web/ac-occupancy.json",
    "node-red/runtime/flows.json": "seed/node-red/flows.json",
    "node-red/runtime/flows_cred.json": "seed/node-red/flows_cred.json",
    "node-red/runtime/.config.runtime.json": "seed/node-red/.config.runtime.json",
}


def docker(*arguments, capture=False):
    return subprocess.run(["docker", *arguments], cwd=ROOT, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def portable_compose():
    config = json.loads(docker("compose", "--profile", "camera", "config", "--no-interpolate",
                               "--no-env-resolution", "--format", "json", capture=True))
    for service in config["services"].values():
        service.pop("build", None)
        for env_file in service.get("env_file", []):
            relative = Path(env_file["path"]).resolve().relative_to(ROOT)
            env_file["path"] = "./" + relative.as_posix()
        for volume in service.get("volumes", []):
            if volume["type"] == "bind":
                relative = Path(volume["source"]).resolve().relative_to(ROOT)
                volume["source"] = "./" + relative.as_posix()
    return config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-build", action="store_true", help="Export images already built and tested")
    parser.add_argument("--include-data", action="store_true", help="Include this machine's private login, AC settings and saved Node-RED flow")
    parser.add_argument("--output", type=Path, default=ROOT / "dist/bimclub-docker-ready-login-windows-amd64.zip")
    args = parser.parse_args()
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if not args.no_build:
        docker("compose", "build")
    for image in IMAGES.values():
        platform = docker("image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image, capture=True).strip()
        if platform != "linux/amd64":
            raise ValueError(f"{image} is {platform}, expected linux/amd64")

    with tempfile.TemporaryDirectory(prefix=".bimclub-package-", dir=output.parent) as temporary:
        bundle = Path(temporary) / "bimclub-docker"
        (bundle / "images").mkdir(parents=True)
        (bundle / "seed/web").mkdir(parents=True)
        (bundle / "seed/node-red").mkdir(parents=True)
        for service, image in IMAGES.items():
            print(f"Saving {service} image", flush=True)
            docker("image", "save", "--output", str(bundle / f"images/{service}.tar"), image)
        (bundle / "compose.yaml").write_text(json.dumps(portable_compose(), indent=2) + "\n", encoding="utf-8")
        for name in (
            "Start-BimClub.ps1", "Start-BimClub.cmd", "DOCKER.md", "LOGIN.md", "DATABASE.md", "database.env.example",
            "CIRA_ACTIVITY.md", "AC_SCHEDULES.md", "node-red/README.md", "node-red/DHT22.md",
            "node_red_dht22_environment_flow.json", "CAMERA.md", "camera.env.example", "camera/mediamtx.yml",
        ):
            (bundle / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, bundle / name)
        if args.include_data:
            for source, destination in SEED_FILES.items():
                if (ROOT / source).is_file():
                    shutil.copy2(ROOT / source, bundle / destination)

        hashes = {}
        for file in bundle.rglob("*"):
            if file.is_file():
                with file.open("rb") as stream:
                    hashes[file.relative_to(bundle).as_posix()] = hashlib.file_digest(stream, "sha256").hexdigest()
        (bundle / "checksums.json").write_text(json.dumps(hashes, indent=2) + "\n", encoding="utf-8")
        archive = Path(temporary) / output.name
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as zipped:
            for file in sorted(bundle.rglob("*")):
                zipped.write(file, file.relative_to(bundle.parent))
        archive.replace(output)
    with output.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    output.with_suffix(output.suffix + ".sha256").write_text(digest + "  " + output.name + "\n", encoding="utf-8")
    print(f"Ready: {output} ({output.stat().st_size / 1024**3:.2f} GiB)", flush=True)


if __name__ == "__main__":
    main()
