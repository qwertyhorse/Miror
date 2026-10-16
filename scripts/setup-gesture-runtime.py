#!/usr/bin/env python3
"""Install the pinned Linux CPU runtime in a user-owned venv; never install globally."""
import argparse
import json
import pathlib
import platform
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", default=sys.executable, help="CPython 3.12 with venv/ensurepip")
    parser.add_argument("--directory", type=pathlib.Path, default=pathlib.Path.home() / ".local/share/miror/gesture-runtime")
    args = parser.parse_args()
    root = pathlib.Path(__file__).resolve().parent.parent
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise SystemExit("This wheel lock targets Linux x86_64. Use a separately verified lock for another platform.")
    probe = subprocess.check_output([args.python, "-c", "import sys,ensurepip,json;print(json.dumps(list(sys.version_info[:2])))"], text=True)
    if json.loads(probe) != [3, 12]:
        raise SystemExit("Use --python with CPython 3.12 (including venv and ensurepip).")
    destination = args.directory.expanduser().resolve()
    if destination.exists() and any(destination.iterdir()) and not (destination / "pyvenv.cfg").exists():
        raise SystemExit("Refusing to overwrite a non-venv directory.")
    # venv is deliberately not --clear: preserve an existing installation and its caches.
    subprocess.run([args.python, "-m", "venv", str(destination)], check=True)
    python = destination / "bin/python"
    subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check", "--only-binary=:all:",
                    "--require-hashes", "-r", str(root / "runtime/gesture/requirements.txt")], check=True)
    subprocess.run([str(python), "-m", "pip", "check"], check=True)
    completed = subprocess.run([str(python), str(root / "scripts/gesture-worker.py"), "--model",
                                str(root / "public/assets/exhibition-gestures/hand_landmarker.task"), "--pose-model",
                                str(root / "public/assets/body-scan/pose_landmarker_full.task")],
                               input="", text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=True)
    if completed.stdout.strip() != '{"type":"ready"}':
        raise SystemExit("Gesture model did not finish its warmup.")
    print(f"Gesture runtime ready: {python}")
    if destination != pathlib.Path.home() / ".local/share/miror/gesture-runtime":
        print(f"Set MIROR_GESTURE_PYTHON={python}")


if __name__ == "__main__":
    main()
