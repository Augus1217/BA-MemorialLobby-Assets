#!/usr/bin/env python3
"""
Extract the memorial-lobby opening video from the BA APK and transcode it.

The Player (BA-MemorialLobby-Player/main.js) expects, under assets/intro/:
    title_h264.mp4   (H.264 video, yuv420p — the APK ships HEVC, must transcode)
    pv-a.ogg         (opening audio)

This step:
  1. Locates the APK via env BA_APK_PATH (or searches WORK_DIR).
  2. Unzips title.mp4 + pv-a.ogg out of it (they live under assets/... in the APK).
  3. Transcodes title.mp4 -> title_h264.mp4 with ffmpeg (libx264 + yuv420p).

It is optional: if no APK is found, it warns and skips so the pipeline still
produces the other 7 packages.

Usage:
    python3 scripts/extract_intro.py [--apk PATH] [--out DIR] [--skip-transcode]
"""
import argparse
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

INTRO_NAMES = ("title.mp4", "pv-a.ogg")


def find_apk(work_dir: Path) -> Path:
    env = os.environ.get("BA_APK_PATH", "")
    if env:
        p = Path(env)
        if p.exists():
            return p
        print(f"BA_APK_PATH set but not found: {p}", file=sys.stderr)
    for pat in ("*.apk", "*.xapk"):
        hits = sorted(work_dir.rglob(pat))
        if hits:
            return hits[0]
    return None


def find_in_apk(apk: Path, want: str) -> str:
    """Return the archive member name ending with `want`."""
    with zipfile.ZipFile(apk) as z:
        for name in z.namelist():
            if name.endswith(want):
                return name
    return None


def extract_intro(apk: Path, out_dir: Path, skip_transcode: bool) -> bool:
    out_dir.mkdir(parents=True, exist_ok=True)
    found_any = False
    for want in INTRO_NAMES:
        member = find_in_apk(apk, want)
        if not member:
            print(f"  {want} not found in APK", file=sys.stderr)
            continue
        dst = out_dir / want
        with zipfile.ZipFile(apk) as z:
            with z.open(member) as src, open(dst, "wb") as f:
                shutil.copyfileobj(src, f)
        print(f"  extracted {member} -> {dst}")
        found_any = True

    raw = out_dir / "title.mp4"
    h264 = out_dir / "title_h264.mp4"
    if raw.exists() and not skip_transcode:
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            print("  ffmpeg not found, keeping HEVC title.mp4 (Player can't play it)", file=sys.stderr)
        else:
            r = subprocess.run([
                ffmpeg, "-y", "-i", str(raw), "-an", "-c:v", "libx264",
                "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", str(h264),
            ], capture_output=True, text=True)
            if r.returncode == 0 and h264.exists():
                print(f"  transcoded -> {h264}")
            else:
                print(f"  transcode failed: {r.stderr[-400:]}", file=sys.stderr)

    return found_any


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apk", type=Path, default=None, help="APK/XAPK path")
    ap.add_argument("--out", type=Path, required=True, help="output intro dir")
    ap.add_argument("--work-dir", type=Path, default=Path("/tmp/ba_build"))
    ap.add_argument("--skip-transcode", action="store_true")
    args = ap.parse_args()

    apk = args.apk or find_apk(args.work_dir)
    if not apk:
        print("WARNING: no APK found, skipping intro extraction", file=sys.stderr)
        return 0
    print(f"Using APK: {apk}")
    ok = extract_intro(apk, args.out, args.skip_transcode)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
