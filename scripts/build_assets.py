#!/usr/bin/env python3
"""BA Memorial Lobby — Full asset build pipeline.

Downloads latest JP game data, extracts spine/voice/BGM, and packages
into distributable tar.gz archives.

Tools used:
  - baad (BA-AD)     : Download JP/GL game data (Rust, fast)
  - baax (BA-AX)     : Extract media resources (molru/zip)
  - ba-downloader     : Extract ExcelDB (FlatBuffer schemas built-in)
  - ba_spine_extractor: Extract Unity AssetBundles (spine data)
  - Node.js scripts   : Extract spine events

Usage:
    python3 scripts/build_assets.py --version 2025.0819.0
    python3 scripts/build_assets.py --version 2025.0819.0 --skip-download
    python3 scripts/build_assets.py --version 2025.0819.0 --only-package
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
WORK_DIR    = Path(os.environ.get("WORK_DIR",        "/tmp/ba_build"))
JP_DIR      = WORK_DIR / "jp"
GL_DIR      = WORK_DIR / "gl"
JP_EXTRACT  = WORK_DIR / "jp_extracted"
GL_EXTRACT  = WORK_DIR / "gl_extracted"
BA_APP      = Path(os.environ.get("BA_APP_DIR",      str(PROJECT_ROOT)))

ASSETS_DIR  = BA_APP / "assets"
SPINE_DIR   = ASSETS_DIR / "spine"
VOICE_DIR   = ASSETS_DIR / "voice"
BGM_DIR     = ASSETS_DIR / "bgm"
DATA_DIR    = ASSETS_DIR / "data"
SCENE_DIR   = ASSETS_DIR / "scene"
OUT_DIR     = WORK_DIR / "out"

# SQLCipher keys (fetched from ba.zmkimu.com)
JP_SQLCIPHER_KEY_URL = "https://ba.zmkimu.com/jp"
GL_SQLCIPHER_KEY_URL = "https://ba.zmkimu.com/gl"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def run(cmd, **kw):
    """Run a command, stream output, raise on failure."""
    print(f"\n{'='*60}")
    print(f"  {' '.join(cmd) if isinstance(cmd, list) else cmd}")
    print(f"{'='*60}")
    result = subprocess.run(cmd, shell=isinstance(cmd, str), **kw)
    if result.returncode != 0:
        print(f"[ERROR] Command exited with code {result.returncode}", file=sys.stderr)
        sys.exit(result.returncode)
    return result


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sizeof_fmt(num):
    for unit in ("B", "KB", "MB", "GB"):
        if abs(num) < 1024:
            return f"{num:.1f} {unit}"
        num /= 1024
    return f"{num:.1f} TB"


def fetch_sqlcipher_key(url):
    """Fetch SQLCipher key from remote endpoint."""
    import urllib.request
    try:
        print(f"  Fetching SQLCipher key from {url} ...")
        req = urllib.request.Request(url, headers={"User-Agent": "BA-MemorialLobby/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            key = resp.read().decode().strip()
        print(f"  Key: {key[:16]}...")
        return key
    except Exception as e:
        print(f"  WARNING: Failed to fetch SQLCipher key: {e}", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Step 1: Download JP data via BA-AD
# ---------------------------------------------------------------------------
def step_download_jp():
    print("\n>>> Step 1: Downloading JP data via baad")
    run([
        "baad", "download", "japan",
        "--tables", "--assets", "--media",
        "--output", str(JP_DIR),
        "--limit", "16", "--boost",
    ])


# ---------------------------------------------------------------------------
# Step 1b: Download GL tables via BA-AD
# ---------------------------------------------------------------------------
def step_download_gl():
    print("\n>>> Step 1b: Downloading GL tables via baad")
    run([
        "baad", "download", "global",
        "--tables",
        "--output", str(GL_DIR),
        "--limit", "8",
    ])


# ---------------------------------------------------------------------------
# Step 2: Extract JP ExcelDB via Deathemonic (baax)
# ---------------------------------------------------------------------------
def step_extract_jp_tables():
    print("\n>>> Step 2: Extracting JP ExcelDB")
    # ba-downloader expects Bundle/ and Media/ in raw-dir
    # BA-AD outputs TableBundles/, AssetBundles/, MediaResources/
    # Create symlinks for ba-downloader compatibility
    raw_dir = JP_DIR
    (raw_dir / "Bundle").symlink_to(raw_dir / "AssetBundles") if not (raw_dir / "Bundle").exists() and (raw_dir / "AssetBundles").exists() else None
    (raw_dir / "Media").symlink_to(raw_dir / "MediaResources") if not (raw_dir / "Media").exists() and (raw_dir / "MediaResources").exists() else None

    JP_EXTRACT.mkdir(parents=True, exist_ok=True)

    # Prefer Deathemonic BA-AX (baax) — 完全用 Deathemonic
    if shutil.which("baax"):
        print("  Trying baax (Deathemonic) for JP tables ...")
        table_input_dir = raw_dir / "TableBundles"
        baax_success = False
        # Try per-file mode (TableBundles contains many zips/dbs)
        if table_input_dir.exists():
            for f in sorted(table_input_dir.rglob("*")):
                if f.is_file() and f.suffix.lower() in [".zip", ".db", ".bytes"]:
                    result = subprocess.run(
                        ["baax", "extract", "table", "--input", str(f), "--output", str(JP_EXTRACT)],
                        capture_output=True, text=True,
                    )
                    if result.returncode == 0:
                        baax_success = True
                    else:
                        print(f"  baax failed for {f.name}: {result.stderr[:400] or result.stdout[:400]}", file=sys.stderr)
            if baax_success:
                print("  baax JP table extraction succeeded")
                return
            print("  baax per-file failed, trying directory mode", file=sys.stderr)
        # Fallback: try directory as input
        table_input = table_input_dir if table_input_dir.exists() else raw_dir
        result = subprocess.run(
            ["baax", "extract", "table", "--input", str(table_input), "--output", str(JP_EXTRACT)],
            capture_output=True, text=True,
        )
        if result.returncode == 0:
            print("  baax JP table extraction succeeded (dir mode)")
            return
        else:
            print(f"  baax failed ({result.returncode}): {(result.stderr or result.stdout)[:800]}", file=sys.stderr)
            print("  Falling back to ba-downloader if available", file=sys.stderr)

    if shutil.which("ba-downloader") is None:
        print("  WARNING: ba-downloader/baax not found, skipping JP table extraction", file=sys.stderr)
        return
    print("  Using ba-downloader for JP ...")
    run([
        "ba-downloader", "extract",
        "--region", "jp",
        "--resource-type", "table",
        "--raw-dir", str(raw_dir),
        "--extract-dir", str(JP_EXTRACT),
        "--threads", "8",
    ])


# ---------------------------------------------------------------------------
# Step 2b: Extract GL ExcelDB via Deathemonic
# ---------------------------------------------------------------------------
def step_extract_gl_tables():
    print("\n>>> Step 2b: Extracting GL ExcelDB")
    raw_dir = GL_DIR
    (raw_dir / "Bundle").symlink_to(raw_dir / "AssetBundles") if not (raw_dir / "Bundle").exists() and (raw_dir / "AssetBundles").exists() else None
    (raw_dir / "Media").symlink_to(raw_dir / "MediaResources") if not (raw_dir / "Media").exists() and (raw_dir / "MediaResources").exists() else None

    GL_EXTRACT.mkdir(parents=True, exist_ok=True)

    # Prefer Deathemonic BA-AX
    if shutil.which("baax"):
        print("  Trying baax (Deathemonic) for GL tables ...")
        table_input_dir = raw_dir / "TableBundles"
        baax_success = False
        if table_input_dir.exists():
            for f in sorted(table_input_dir.rglob("*")):
                if f.is_file() and f.suffix.lower() in [".zip", ".db", ".bytes"]:
                    result = subprocess.run(
                        ["baax", "extract", "table", "--input", str(f), "--output", str(GL_EXTRACT)],
                        capture_output=True, text=True,
                    )
                    if result.returncode == 0:
                        baax_success = True
                    else:
                        print(f"  baax failed for {f.name}: {result.stderr[:400] or result.stdout[:400]}", file=sys.stderr)
            if baax_success:
                print("  baax GL table extraction succeeded")
                return
            print("  baax per-file failed, trying directory mode", file=sys.stderr)
        table_input = table_input_dir if table_input_dir.exists() else raw_dir
        result = subprocess.run(
            ["baax", "extract", "table", "--input", str(table_input), "--output", str(GL_EXTRACT)],
            capture_output=True, text=True,
        )
        if result.returncode == 0:
            print("  baax GL table extraction succeeded (dir mode)")
            return
        else:
            print(f"  baax failed ({result.returncode}): {(result.stderr or result.stdout)[:800]}", file=sys.stderr)
            print("  Falling back to ba-downloader if available", file=sys.stderr)

    if shutil.which("ba-downloader") is None:
        print("  WARNING: ba-downloader/baax not found, skipping GL table extraction", file=sys.stderr)
        return
    print("  Using ba-downloader for GL ...")
    run([
        "ba-downloader", "extract",
        "--region", "gl",
        "--resource-type", "table",
        "--raw-dir", str(raw_dir),
        "--extract-dir", str(GL_EXTRACT),
        "--threads", "4",
    ])


# ---------------------------------------------------------------------------
# Step 3: Extract JP bundles via ba_spine_extractor.py
# ---------------------------------------------------------------------------
def step_extract_bundles():
    print("\n>>> Step 3: Extracting JP bundles via ba_spine_extractor.py")
    bundle_dir = JP_DIR / "AssetBundles"
    if not bundle_dir.exists():
        bundle_dir = JP_DIR / "Bundle"
    if not bundle_dir.exists():
        # Check if already extracted
        spine_candidates = list(JP_EXTRACT.rglob("SpineLobbies"))
        if spine_candidates:
            print(f"  Skipping — extracted SpineLobbies already found at {spine_candidates[0]}")
            return
        print(f"  ERROR: AssetBundles directory not found", file=sys.stderr)
        sys.exit(1)

    extractor = Path(__file__).resolve().parent.parent.parent / "ba_spine_extractor.py"
    if not extractor.exists():
        extractor = Path("/home/augus/ba_spine_extractor.py")
    if not extractor.exists():
        for cand in [SCRIPT_DIR / "ba_spine_extractor.py", PROJECT_ROOT / "ba_spine_extractor.py", Path("/home/augus/BA_MemorialLobby/ba_spine_extractor.py")]:
            if cand.exists():
                extractor = cand
                break
    if not extractor.exists():
        fallback = SCRIPT_DIR / "extract_spine_unitypy.py"
        if fallback.exists():
            print(f"  ba_spine_extractor.py not found, using fallback {fallback}", file=sys.stderr)
            run([sys.executable, str(fallback), str(bundle_dir), "--output", str(JP_EXTRACT), "--workers", "4"])
            return
        print(f"  WARNING: ba_spine_extractor.py not found, skipping bundle extraction (改用 BA-AX 或手動放置)", file=sys.stderr)
        return

    run([
        sys.executable, str(extractor),
        str(bundle_dir),
        "--output", str(JP_EXTRACT),
        "--workers", "8",
    ])


# ---------------------------------------------------------------------------
# Step 4: Extract media (BGM, voice) via baax
# ---------------------------------------------------------------------------
def step_extract_media():
    print("\n>>> Step 4: Extracting media via baax")
    media_dir = JP_DIR / "MediaResources"
    if not media_dir.exists():
        media_dir = JP_DIR / "Media"
    if not media_dir.exists():
        print(f"  WARNING: MediaResources not found, skipping media extraction")
        return

    out_dir = WORK_DIR / "media_extracted"
    out_dir.mkdir(parents=True, exist_ok=True)

    # Extract all .zip and .nolru files
    for f in sorted(media_dir.rglob("*")):
        if f.suffix in (".zip", ".nolru", ".molru"):
            print(f"  Extracting {f.name}...")
            run([
                "baax", "extract", "media",
                "--input", str(f),
                "--output", str(out_dir / f.stem),
            ], check=False)


# ---------------------------------------------------------------------------
# Step 5: Copy assets into project
# ---------------------------------------------------------------------------
def step_copy_assets():
    print("\n>>> Step 5: Copying assets into project")
    # Determine spine source path
    spine_src = JP_EXTRACT / "Assets" / "_MX" / "SpineLobbies"
    if not spine_src.exists():
        for candidate in [
            JP_EXTRACT / "Assets" / "BundleData" / "Assets" / "_MX" / "SpineLobbies",
            JP_EXTRACT / "SpineLobbies",
        ]:
            if candidate.exists():
                spine_src = candidate
                break
    if not spine_src.exists():
        print(f"  WARNING: SpineLobbies not found under {JP_EXTRACT}, skipping spine copy (需 ba_spine_extractor.py 或 BA-AX)", file=sys.stderr)
        spine_src = None

    # Determine voice source path
    voice_src = WORK_DIR / "media_extracted"
    if not voice_src.exists():
        for candidate in [
            JP_DIR / "MediaResources",
            JP_DIR / "Media",
            WORK_DIR / "jp_voice",
        ]:
            if candidate.exists() and any(d.name.startswith("JP_") for d in candidate.iterdir() if d.is_dir()):
                voice_src = candidate
                break
    if not voice_src.exists():
        print(f"  WARNING: Voice source not found, voice may be missing", file=sys.stderr)

    # Determine BGM source path
    bgm_src = None
    for candidate in [
        JP_DIR / "MediaResources" / "GameData" / "Audio" / "BGM",
        JP_DIR / "Media" / "GameData" / "Audio" / "BGM",
        JP_DIR / "MediaResources" / "Audio" / "BGM",
        WORK_DIR / "media_extracted",
    ]:
        if candidate.exists():
            bgm_src = candidate
            break

    # Determine data source (BA_MemorialLobby project)
    data_src = Path("/home/augus/BA_MemorialLobby/data")
    if not data_src.exists():
        print(f"  WARNING: BA_MemorialLobby/data not found, metadata may be stale", file=sys.stderr)

    env = os.environ.copy()
    if spine_src and spine_src.exists():
        env["BA_SRC_SPINE"] = str(spine_src)
    else:
        print("  Skipping spine env (SpineLobbies missing)", file=sys.stderr)
    if voice_src and voice_src.exists():
        env["BA_SRC_MEDIA"] = str(voice_src)
    if bgm_src and bgm_src.exists():
        env["BA_SRC_BGM"] = str(bgm_src)
    if data_src.exists():
        env["BA_SRC_DATA"] = str(data_src)

    run([sys.executable, str(SCRIPT_DIR / "copy_assets.py")], env=env)


# ---------------------------------------------------------------------------
# Step 6: Extract spine events
# ---------------------------------------------------------------------------
def step_extract_events():
    print("\n>>> Step 6: Extracting spine events")
    node = shutil.which("node")
    if not node:
        print("  ERROR: node not found", file=sys.stderr)
        sys.exit(1)

    extract_script = SCRIPT_DIR / "extract_events.mjs"
    if not extract_script.exists():
        print(f"  ERROR: extract_events.mjs not found", file=sys.stderr)
        sys.exit(1)

    result = subprocess.run(
        [node, str(extract_script), str(SPINE_DIR)],
        capture_output=True, text=True, cwd=str(BA_APP),
    )
    if result.returncode != 0:
        print(f"  WARNING: extract_events failed: {result.stderr[:500]}", file=sys.stderr)
    else:
        events_file = WORK_DIR / "events.json"
        events_file.write_text(result.stdout)
        print(f"  Events saved to {events_file}")


# ---------------------------------------------------------------------------
# Step 7: Extract lobby_dialog_types from GL CharacterDialogDB
# ---------------------------------------------------------------------------
def step_extract_dialog_types():
    print("\n>>> Step 7: Extracting lobby_dialog_types from GL CharacterDialogDB")
    cdb_path = GL_EXTRACT / "Table" / "ExcelDB" / "CharacterDialogDBSchema.json"
    if not cdb_path.exists():
        for candidate in [
            GL_EXTRACT / "ExcelDB" / "CharacterDialogDBSchema.json",
            Path("/home/augus/Blue-Archive-Asset-Downloader/GL_Extracted/Table/ExcelDB/CharacterDialogDBSchema.json"),
        ]:
            if candidate.exists():
                cdb_path = candidate
                break
    if not cdb_path.exists():
        print(f"  WARNING: CharacterDialogDB not found, skipping dialog types extraction")
        return

    with open(cdb_path, encoding="utf-8") as f:
        cdb = json.load(f)

    lobby_entries = [
        e for e in cdb
        if e.get("Bytes", {}).get("DialogCategory") == "UILobbySpecial"
    ]
    print(f"  Found {len(lobby_entries)} UILobbySpecial entries")

    char_map = {}
    students_csv = DATA_DIR / "students_data.csv"
    if students_csv.exists():
        import csv
        with open(students_csv, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                fid = row.get("file_id", "")
                sid = row.get("student_id", "")
                if fid and sid:
                    try:
                        char_map[int(sid)] = fid
                    except ValueError:
                        pass

    from collections import defaultdict
    by_char_group = defaultdict(list)
    for e in lobby_entries:
        b = e["Bytes"]
        cid = b.get("CharacterId")
        gid = b.get("GroupId")
        if cid and gid:
            by_char_group[(cid, gid)].append(b)

    dialog_types = {}
    for (cid, gid), entries in sorted(by_char_group.items()):
        spine_name = char_map.get(cid, str(cid))
        sorted_entries = sorted(entries, key=lambda x: x.get("DisplayOrder", 0))
        for idx, entry in enumerate(sorted_entries, 1):
            anim_name = f"{spine_name}_MemorialLobby_{gid}_{idx}"
            dtype = entry.get("DialogType", "Talk")
            dialog_types[anim_name] = dtype

    print(f"  Generated {len(dialog_types)} dialog type entries")

    out_path = DATA_DIR / "lobby_dialog_types.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(dialog_types, f, ensure_ascii=False, indent=1)
    print(f"  Written to {out_path}")


# ---------------------------------------------------------------------------
# Step 7b-7e: Extract metadata files
# ---------------------------------------------------------------------------
def step_extract_voice_index():
    print("\n>>> Step 7b: Extracting voice_index.json")
    run([sys.executable, str(SCRIPT_DIR / "extract_voice_index.py"),
         "--voice-dir", str(VOICE_DIR),
         "--output", str(DATA_DIR / "voice_index.json")])


def step_extract_bgm_mapping():
    print("\n>>> Step 7c: Extracting lobby_bgm_mapping.csv")
    jp_table = JP_EXTRACT / "Table" / "ExcelDB"
    if not jp_table.exists():
        jp_table = Path("/home/augus/JP_Extracted/Table/ExcelDB")
    if not jp_table.exists():
        print("  WARNING: JP ExcelDB not found, skipping BGM mapping extraction")
        return
    run([sys.executable, str(SCRIPT_DIR / "extract_bgm_mapping.py"),
         "--jp-table", str(jp_table),
         "--output", str(DATA_DIR / "lobby_bgm_mapping.csv")])


def step_extract_students():
    print("\n>>> Step 7d: Extracting students_data.csv")
    run([sys.executable, str(SCRIPT_DIR / "extract_students.py"),
         "--output", str(DATA_DIR / "students_data.csv")])


def step_extract_subtitles():
    print("\n>>> Step 7e: Extracting lobby_subtitle.json")
    gl_table = GL_EXTRACT / "Table" / "ExcelDB"
    if not gl_table.exists():
        gl_table = Path("/home/augus/Blue-Archive-Asset-Downloader/GL_Extracted/Table/ExcelDB")
    cmd = [sys.executable, str(SCRIPT_DIR / "extract_subtitles.py"),
           "--existing", str(DATA_DIR / "lobby_subtitle.json"),
           "--output", str(DATA_DIR / "lobby_subtitle.json")]
    if gl_table.exists():
        cmd.insert(3, "--gl-table")
        cmd.insert(4, str(gl_table))
    run(cmd)


# ---------------------------------------------------------------------------
# Step 8: Package assets as tar.gz
# ---------------------------------------------------------------------------
def step_package():
    print("\n>>> Step 8: Packaging assets")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    version = ARGS.version
    packages = {}

    for name, src_dir in [
        ("spine",   SPINE_DIR),
        ("voice",   VOICE_DIR),
        ("bgm",     BGM_DIR),
        ("scene",   SCENE_DIR),
        ("data",    DATA_DIR),
        ("intro",   ASSETS_DIR / "intro"),
        ("ui",      ASSETS_DIR / "ui"),
        ("students", ASSETS_DIR / "students"),
    ]:
        if not src_dir.exists():
            print(f"  WARNING: {name} directory not found at {src_dir}, skipping")
            continue

        tar_name = f"assets-{name}-v{version}.tar.gz"
        tar_path = OUT_DIR / tar_name
        print(f"  Packaging {name}...", flush=True)

        all_files = [item for item in src_dir.rglob("*") if item.is_file()]
        total = len(all_files)
        print(f"    {total} files to package", flush=True)

        with tarfile.open(tar_path, "w:gz") as tar:
            for i, item in enumerate(all_files, 1):
                if i % 500 == 0 or i == total:
                    print(f"    ... {i}/{total} ({i*100//total}%)", flush=True)
                arcname = f"assets/{name}/{item.relative_to(src_dir)}"
                tar.add(item, arcname=arcname)

        size = tar_path.stat().st_size
        sha = sha256_file(tar_path)
        packages[name] = {
            "url": f"https://github.com/Augus1217/BA-MemorialLobby-Assets/releases/download/v{version}/{tar_name}",
            "sha256": sha,
            "size": size,
        }
        print(f"  {tar_name}: {sizeof_fmt(size)} (sha256: {sha[:16]}...)")

    version_info = {
        "version": version,
        "packages": packages,
        "buildDate": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    version_path = OUT_DIR / "assets_version.json"
    with open(version_path, "w") as f:
        json.dump(version_info, f, indent=2)
    print(f"\n  Version manifest: {version_path}")

    assets_version_path = ASSETS_DIR / ".version"
    with open(assets_version_path, "w") as f:
        f.write(version)
    print(f"  Assets version marker: {assets_version_path}")

    return packages


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def parse_args():
    p = argparse.ArgumentParser(description="BA Memorial Lobby asset build pipeline")
    p.add_argument("--version", required=True, help="Version string (e.g. 2025.0819.0)")
    p.add_argument("--skip-download", action="store_true", help="Skip all download steps")
    p.add_argument("--skip-extract", action="store_true", help="Skip bundle/table/media extraction")
    p.add_argument("--skip-copy", action="store_true", help="Skip copy_assets step")
    p.add_argument("--skip-events", action="store_true", help="Skip spine events extraction")
    p.add_argument("--skip-dialog-types", action="store_true", help="Skip dialog types extraction")
    p.add_argument("--skip-metadata", action="store_true", help="Skip metadata extraction")
    p.add_argument("--only-package", action="store_true", help="Only package existing assets")
    return p.parse_args()


def main():
    global ARGS
    ARGS = parse_args()

    print(f"BA Memorial Lobby — Asset Build Pipeline")
    print(f"Version: {ARGS.version}")
    print(f"Work dir: {WORK_DIR}")
    print(f"App dir: {BA_APP}")
    print(f"Assets dir: {ASSETS_DIR}")

    t0 = time.time()

    if not ARGS.only_package:
        if not ARGS.skip_download:
            step_download_jp()
            step_download_gl()

        if not ARGS.skip_extract:
            step_extract_jp_tables()
            step_extract_gl_tables()
            step_extract_bundles()
            step_extract_media()

        if not ARGS.skip_copy:
            step_copy_assets()

        if not ARGS.skip_events:
            step_extract_events()

        if not ARGS.skip_dialog_types:
            step_extract_dialog_types()

        if not ARGS.skip_metadata:
            step_extract_voice_index()
            step_extract_bgm_mapping()
            step_extract_students()
            step_extract_subtitles()

    packages = step_package()

    elapsed = time.time() - t0
    print(f"\n{'='*60}")
    print(f"  Build complete in {elapsed:.0f}s")
    print(f"  Output: {OUT_DIR}")
    print(f"  Packages: {len(packages)}")
    for name, info in packages.items():
        print(f"    {name}: {sizeof_fmt(info['size'])}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
