#!/usr/bin/env python3
"""Capture production Android views in the isolated, permissionless uiPreview APK.

Build first: ./gradlew :app:assembleUiPreview
Example: python3 scripts/capture-ui-preview.py --serial emulator-5554 \
    --apk app/build/outputs/apk/uiPreview/app-uiPreview.apk --size 1080x1920 \
    --output ../../output/android-ui-0.3.3/1080x1920

The script only installs/stops ai.openbuy.exhibition.uipreview. Source images are
copied unchanged into that application's private files. It never starts the real
Activity, contacts a backend, grants camera permission or clears real app data.
Temporary display overrides are restored even if a capture fails.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import struct
import subprocess
import tempfile
import time


PROJECT = Path(__file__).resolve().parents[1]
REPOSITORY = PROJECT.parents[1]
PACKAGE = "ai.openbuy.exhibition.uipreview"
ACTIVITY = f"{PACKAGE}/ai.openbuy.exhibition.UiPreviewActivity"
SCENARIOS = (
    "waiting", "ready", "generating", "stopping", "paused", "recovering",
    "idle-countdown", "error", "empty", "drawer-one", "drawer-two", "pairing",
    "crystal", "custom", "settings-local", "settings-no-camera",
    "settings-long-url", "settings-keyboard", "camera-remote", "camera-error",
    "camera-scanning",
)


def find_adb():
    executable = shutil.which("adb")
    if executable:
        return executable
    toolchain = Path(os.environ.get("OPENBUY_ANDROID_TOOLCHAIN", Path.home() / ".local/share/openbuy-android"))
    candidates = [Path(os.environ.get("ANDROID_HOME", "/nonexistent")) / "platform-tools/adb",
                  toolchain / "sdk/platform-tools/adb", toolchain / "android-sdk/platform-tools/adb",
                  Path.home() / "Library/Android/sdk/platform-tools/adb"]
    return next((str(path) for path in candidates if path.is_file()), "adb")


def arguments():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--serial", required=True, help="Explicit emulator/device serial; never auto-select a device.")
    parser.add_argument("--adb", default=find_adb())
    parser.add_argument("--apk", type=Path, help="Optional uiPreview APK to install; real app APKs are rejected.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--size", help="Temporary display size, e.g. 1080x1920; omitted preserves the current size.")
    parser.add_argument("--density", type=int, help="Optional temporary display density, restored on exit.")
    parser.add_argument("--camera-image", type=Path, help="Optional local still to stand in for video; copied byte for byte.")
    parser.add_argument("--scenarios", nargs="+", choices=SCENARIOS, default=SCENARIOS)
    parser.add_argument("--web-reference", action="store_true", help="Also save a local HTML reference using the actual web CSS.")
    return parser.parse_args()


def fixture_assets(camera_image=None):
    seed = REPOSITORY / "seed/exhibition-mirrors/default"
    state = json.loads((seed / "exhibition.json").read_text())["state"]
    clothes = [look for look in state["looks"] if look.get("mode") == "clothx"]
    # The supplied web reference uses the same golden white gown.
    clothes.sort(key=lambda look: look.get("name") != "鎏金女神装")
    materials, assets = [], {}
    for index, look in enumerate(clothes[:10]):
        identifier = look["image"].rsplit("/", 1)[-1]
        candidates = sorted((seed / "exhibition-assets").glob(identifier + ".*"))
        if len(candidates) != 1:
            raise RuntimeError(f"Expected one local fixture image for {identifier}")
        name = f"look-{index}{candidates[0].suffix}"
        materials.append({"id": look["id"], "name": look["name"], "image": name})
        assets[name] = candidates[0]
    if not materials:
        raise RuntimeError("No repository clothing fixtures found")
    assets["camera.png"] = camera_image or REPOSITORY / "public/assets/exhibition/commute-cutout.png"
    assets["custom.png"] = REPOSITORY / "public/assets/exhibition/backdrop.png"
    for path in assets.values():
        if not path.is_file():
            raise RuntimeError(f"Fixture image not found: {path}")
    return materials, assets


def original_override(output):
    match = re.search(r"Override (?:size|density):\s*(\S+)", output)
    return match.group(1) if match else "reset"


def save_web_reference(output, materials, assets):
    """Only writes local artifacts; serving/opening is left to the operator."""
    reference = output / "web-reference"
    reference.mkdir(parents=True, exist_ok=True)
    for name, path in assets.items():
        shutil.copyfile(path, reference / name)
    for name in ("brand-frame-texture.svg", "openbuy-ai-logo-rgb.png", "backdrop.png"):
        shutil.copyfile(REPOSITORY / "public/assets/exhibition" / name, reference / name)
    css = "\n".join((REPOSITORY / "src/exhibition" / name).read_text()
                    for name in ("exhibition.css", "mirror-screen.css"))
    css = css.replace("/assets/exhibition/", "./")
    (reference / "reference.css").write_text(css)
    template = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Android UI — local web CSS reference</title><link rel="stylesheet" href="reference.css">
<style>html,body{margin:0;width:100%;height:100%;background:#000}body{font-family:Arial,'Noto Sans CJK SC',sans-serif}
.ex-screen-page{background:#000}.fixture-camera{width:100%;height:100%;object-fit:cover}.ex-mirror-poster{object-fit:contain}
</style></head><body class="ex-app"><main class="ex-screen-page"><section class="ex-kiosk ex-mirror-minimal" data-skin="brand">
<header class="ex-mirror-brand"><div class="ex-brand"><img src="openbuy-ai-logo-rgb.png" alt="OpenBuyAI"></div></header>
<div class="ex-mirror-stage"><img id="media" class="fixture-camera" src="camera.png" alt="">
<div class="ex-mirror-drawer" data-columns="2"><div class="ex-mirror-drawer-panel" hidden><strong>选择服装</strong><div class="ex-mirror-drawer-grid"></div></div>
<button class="ex-mirror-drawer-toggle" aria-label="选择服装"></button></div>
<div class="ex-mirror-stage-actions"><button class="ex-kiosk-primary"></button><button class="ex-kiosk-continue" hidden></button></div></div>
</section></main><script>
const looks=__MATERIALS__;
const scenario=new URLSearchParams(location.search).get('scenario')||'ready';
const svg=(body,fill='none')=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const play=svg('<polygon points="6 3 20 12 6 21 6 3"/>','currentColor');
const stop=svg('<rect width="18" height="18" x="3" y="3" rx="2"/>','currentColor');
const recover=svg('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>');
const active=['generating','stopping','paused','idle-countdown'].includes(scenario);
const waiting=scenario==='waiting';
const primary=document.querySelector('.ex-kiosk-primary');
primary.innerHTML=(scenario==='recovering'?recover:active?stop:play)+(waiting?'等待摄像头…':scenario==='recovering'?'恢复操作':scenario==='stopping'?'正在停止…':active?'停止生成':'开始体验');
primary.disabled=waiting||scenario==='stopping'||scenario==='empty';
const media=document.querySelector('#media');
media.src=waiting||active||scenario==='recovering'?looks[0].image:'camera.png';
if(waiting)media.className='ex-mirror-poster';
const resume=document.querySelector('.ex-kiosk-continue');
resume.hidden=scenario!=='paused';resume.style.display=resume.hidden?'none':'flex';resume.innerHTML=play+'继续体验';
const drawer=document.querySelector('.ex-mirror-drawer');
const open=scenario==='drawer-one'||scenario==='drawer-two';
drawer.classList.toggle('is-open',open);drawer.dataset.columns=scenario==='drawer-one'?'1':'2';
const panel=document.querySelector('.ex-mirror-drawer-panel');panel.hidden=!open;panel.style.display=open?'flex':'none';
document.querySelector('.ex-mirror-drawer-toggle').innerHTML=svg(open?'<path d="m15 18-6-6 6-6"/>':'<path d="m9 18 6-6-6-6"/>');
document.querySelector('.ex-mirror-drawer-grid').innerHTML=looks.map((look,i)=>`<button class="ex-mirror-drawer-item ${i?'':'is-selected'}"><img src="${look.image}" alt="">${i?'':`<span class="ex-mirror-drawer-check">${svg('<path d="m20 6-11 11-5-5"/>')}</span>`}</button>`).join('');
if(scenario==='crystal'||scenario==='custom'){const canvas=document.querySelector('.ex-kiosk');canvas.dataset.skin=scenario;canvas.style.backgroundImage='url(backdrop.png)'}
</script></body></html>"""
    (reference / "index.html").write_text(template.replace("__MATERIALS__", json.dumps(materials, ensure_ascii=False)))
    return str(reference / "index.html")


def main():
    args = arguments()
    if args.size and not re.fullmatch(r"[1-9][0-9]{2,4}x[1-9][0-9]{2,4}", args.size):
        raise SystemExit("--size must be a portrait dimension such as 1080x1920")
    if args.density and not 80 <= args.density <= 1000:
        raise SystemExit("--density must be between 80 and 1000")
    if args.apk and (not args.apk.is_file() or "uipreview" not in str(args.apk).lower()):
        raise SystemExit("--apk must name the separately built uiPreview APK")
    adb = [args.adb, "-s", args.serial]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)

    def run(*command, data=None, check=True):
        result = subprocess.run(adb + list(command), input=data, capture_output=True, check=False, timeout=30)
        if check and result.returncode:
            raise RuntimeError(result.stderr.decode(errors="replace") or result.stdout.decode(errors="replace"))
        return result

    def shell(*command):
        return run("shell", *command).stdout.decode(errors="replace").strip()

    def private_file(name, data):
        # adb push closes its transfer deterministically, unlike exec-in with a large
        # stdin stream. Keep the final copy entirely on-device and discard tee output.
        remote_dir = f"/data/local/tmp/openbuy-ui033-{os.getpid()}"
        remote_file = f"{remote_dir}/{name}"
        destination = f"files/ui-preview/{name}"
        with tempfile.TemporaryDirectory(prefix="openbuy-ui033-") as temporary:
            source = Path(temporary) / name
            source.write_bytes(data)
            shell("mkdir", "-p", remote_dir)
            try:
                run("push", str(source), remote_file)
                # Read under shell's UID, then write under the preview app's UID.
                # This also works on emulators that disallow run-as reading shell data.
                shell(f"cat {shlex.quote(remote_file)} | run-as {PACKAGE} tee {shlex.quote(destination)} >/dev/null")
                copied_size = shell("run-as", PACKAGE, "stat", "-c", "%s", destination)
                if copied_size != str(len(data)):
                    raise RuntimeError(f"Incomplete preview asset transfer: {name}")
            finally:
                run("shell", "rm", "-rf", remote_dir, check=False)

    if args.apk:
        run("install", "-r", str(args.apk.resolve()))
    package = shell("dumpsys", "package", PACKAGE)
    if "Unable to find package" in package or f"Package [{PACKAGE}]" not in package:
        raise RuntimeError("Install the uiPreview APK first, or provide --apk")
    requested = package.split("requested permissions:", 1)[-1].split("install permissions:", 1)[0]
    if any(permission in requested for permission in ("android.permission.INTERNET", "android.permission.CAMERA")):
        raise RuntimeError("Refusing preview APK with network/camera permissions; check the merged uiPreview manifest")
    materials, assets = fixture_assets(args.camera_image)
    shell("run-as", PACKAGE, "mkdir", "-p", "files/ui-preview")
    private_file("materials.json", json.dumps(materials, ensure_ascii=False).encode())
    for name, path in assets.items():
        private_file(name, path.read_bytes())
    original_size = shell("wm", "size")
    original_density = shell("wm", "density")
    metadata = {"package": PACKAGE, "serial": args.serial, "sourceImages": {
        name: {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for name, path in assets.items()
    }, "originalSize": original_size, "originalDensity": original_density,
        "requestedSize": args.size, "requestedDensity": args.density, "liveServices": False,
        "note": "Camera/generated frames are local still fixtures; no real camera or XMAX was started.", "captures": []}
    if args.web_reference:
        metadata["webReference"] = save_web_reference(output, materials, assets)
    try:
        if args.size:
            shell("wm", "size", args.size)
        if args.density:
            shell("wm", "density", str(args.density))
        for scenario in args.scenarios:
            shell("am", "force-stop", PACKAGE)
            shell("run-as", PACKAGE, "rm", "-f", "files/ui-preview/snapshot.json")
            started = shell("am", "start", "-W", "-n", ACTIVITY, "--es", "scenario", scenario)
            if "Error:" in started or "Exception" in started:
                raise RuntimeError(started)
            time.sleep(1.8 if scenario == "settings-keyboard" else 1.0)
            snapshot = None
            for _ in range(30):
                result = run("exec-out", "run-as", PACKAGE, "cat", "files/ui-preview/snapshot.json", check=False)
                if result.returncode == 0:
                    try:
                        candidate = json.loads(result.stdout)
                        if candidate.get("scenario") == scenario and candidate.get("rendered"):
                            snapshot = candidate
                            break
                    except json.JSONDecodeError:
                        pass
                time.sleep(.1)
            if snapshot is None:
                raise RuntimeError(f"Fixture did not render: {scenario}; inspect adb logcat for UiPreviewActivity")
            png = run("exec-out", "screencap", "-p").stdout
            if not png.startswith(b"\x89PNG\r\n\x1a\n"):
                raise RuntimeError(f"Invalid screenshot for {scenario}")
            width, height = struct.unpack(">II", png[16:24])
            if args.size and (width, height) != tuple(map(int, args.size.split("x"))):
                raise RuntimeError(f"Requested {args.size}, but Android captured {width}x{height}; "
                                   "use an AVD with a matching physical display instead of a clamped wm override")
            (output / f"{scenario}.png").write_bytes(png)
            (output / f"{scenario}.json").write_text(json.dumps(snapshot, ensure_ascii=False, indent=2))
            metadata["captures"].append({"scenario": scenario, "width": width, "height": height,
                                         "file": f"{scenario}.png"})
            print(f"Captured {scenario}: {width}×{height}", flush=True)
    finally:
        run("shell", "am", "force-stop", PACKAGE, check=False)
        if args.size:
            run("shell", "wm", "size", original_override(original_size), check=False)
        if args.density:
            run("shell", "wm", "density", original_override(original_density), check=False)
        (output / "capture-manifest.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
    print(output)


if __name__ == "__main__":
    main()
