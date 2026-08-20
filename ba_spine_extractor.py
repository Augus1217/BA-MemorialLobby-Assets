#!/usr/bin/env python3
"""
ba_full_extractor.py

Extract EVERY object out of every Blue Archive Unity AssetBundle that
UnityPy can successfully parse (i.e. isn't encrypted/corrupted at the
bundle level). No type filtering, no content filtering.

Six well-known types get exported in their natural, directly-usable
format:
    Texture2D / Sprite -> .png
    TextAsset          -> raw bytes as-is
    AudioClip          -> decoded audio samples (.wav/.ogg etc.)
    Mesh               -> .obj (Wavefront), when UnityPy can produce one
    Font               -> .ttf / .otf

Everything else (MonoBehaviour, Material, GameObject, AnimationClip,
Shader, etc.) is dumped as a JSON file of its parsed type-tree fields,
so no data is silently dropped just because it's not one of the six
"nice" types.

Preserves the original container path (the same info AssetRipper uses
to rebuild project structure) so files that belong together end up in
the same output folder.

Processes ONE bundle at a time and frees memory between bundles, so it
won't blow up your RAM the way loading everything at once does.

Requires:
    pip install UnityPy Pillow --break-system-packages

Usage:
    python3 ba_full_extractor.py \
        ~/Blue-Archive-Asset-Downloader/GL_RawData/Bundle \
        --output ~/BA_Extracted_Full

    # Quick dry run first (recommended given how much this will export):
    python3 ba_full_extractor.py <bundle_dir> --output <out> --dry-run
"""

import argparse
import gc
import json
import multiprocessing as mp
from pathlib import Path

import UnityPy

KNOWN_TYPES = {"TextAsset", "Texture2D", "Sprite", "AudioClip", "Mesh", "Font"}


def to_bytes(x) -> bytes:
    """Normalize UnityPy's binary-ish fields (bytes, bytearray, or list[int]
    depending on version) into a real bytes object."""
    if isinstance(x, bytes):
        return x
    return bytes(x)


def sniff_font_ext(data: bytes) -> str:
    if data[:4] == b"OTTO":
        return ".otf"
    return ".ttf"  # covers 0x00010000, 'true', 'ttcf' style TTF/TTC headers


def unique_path(path: Path) -> Path:
    """Avoid clobbering files when two objects share a name in one folder."""
    if not path.exists():
        return path
    stem, suffix, parent = path.stem, path.suffix, path.parent
    n = 1
    while True:
        candidate = parent / f"{stem}_{n}{suffix}"
        if not candidate.exists():
            return candidate
        n += 1


def export_object(obj, data, out_dir: Path, name: str, dry_run: bool) -> int:
    """Returns number of files written (some types, like AudioClip, can be >1)."""
    obj_type = obj.type.name
    count = 0

    if obj_type in ("Texture2D", "Sprite"):
        out_file = unique_path(out_dir / f"{name}.png")
        print(f"  [{obj_type:<13}] {out_file}")
        if not dry_run:
            try:
                data.image.save(out_file)
                count += 1
            except Exception as e:
                print(f"    [WARN] image export failed: {e}")

    elif obj_type == "TextAsset":
        raw = data.m_Script
        if isinstance(raw, str):
            raw = raw.encode("utf-8", "surrogateescape")
        else:
            raw = to_bytes(raw)
        out_file = unique_path(out_dir / (name or "unnamed.bytes"))
        print(f"  [{obj_type:<13}] {out_file}")
        if not dry_run:
            out_file.write_bytes(raw)
            count += 1

    elif obj_type == "AudioClip":
        try:
            samples = data.samples  # dict: {sample_filename: raw_audio_bytes}
        except Exception as e:
            print(f"    [WARN] audio export failed: {e}")
            samples = {}
        for sample_name, sample_bytes in samples.items():
            out_file = unique_path(out_dir / sample_name)
            print(f"  [{obj_type:<13}] {out_file}")
            if not dry_run:
                out_file.write_bytes(to_bytes(sample_bytes))
                count += 1

    elif obj_type == "Mesh":
        try:
            obj_text = data.export()  # Wavefront OBJ text, if UnityPy can produce it
        except Exception as e:
            print(f"    [WARN] mesh export failed (non-OBJ data?): {e}")
            obj_text = None
        if obj_text:
            out_file = unique_path(out_dir / f"{name}.obj")
            print(f"  [{obj_type:<13}] {out_file}")
            if not dry_run:
                out_file.write_text(obj_text)
                count += 1

    elif obj_type == "Font":
        font_bytes = getattr(data, "m_FontData", None)
        if font_bytes:
            font_bytes = to_bytes(font_bytes)
            ext = sniff_font_ext(font_bytes[:4])
            out_file = unique_path(out_dir / f"{name}{ext}")
            print(f"  [{obj_type:<13}] {out_file}")
            if not dry_run:
                out_file.write_bytes(font_bytes)
                count += 1

    else:
        # Generic fallback for everything we don't have a dedicated
        # exporter for: dump the parsed type-tree as JSON so the data
        # isn't silently dropped.
        try:
            tree = obj.read_typetree()
        except Exception as e:
            print(f"    [WARN] typetree read failed for {obj_type} '{name}': {e}")
            tree = None
        if tree is not None:
            out_file = unique_path(out_dir / f"{name}.json")
            print(f"  [{obj_type:<13}] {out_file}")
            if not dry_run:
                try:
                    out_file.write_text(
                        json.dumps(tree, indent=2, ensure_ascii=False, default=repr)
                    )
                    count += 1
                except Exception as e:
                    print(f"    [WARN] JSON write failed for {obj_type} '{name}': {e}")

    return count


def export_bundle(bundle_path: Path, out_root: Path, dry_run: bool) -> int:
    try:
        env = UnityPy.load(str(bundle_path))
    except Exception as e:
        print(f"  [SKIP] failed to load (likely encrypted/corrupted): {e}")
        return 0

    path_by_id = {}
    try:
        for path, obj in env.container.items():
            path_by_id[obj.path_id] = path
    except Exception:
        pass  # no container info in this bundle

    exported = 0
    total_objs = 0
    for obj in env.objects:
        total_objs += 1
        container_path = path_by_id.get(obj.path_id)

        try:
            data = obj.read()
        except Exception as e:
            print(f"  [WARN] failed to read object {obj.path_id} ({obj.type.name}): {e}")
            continue

        name = getattr(data, "m_Name", "") or f"unnamed_{obj.path_id}"

        if container_path:
            out_dir = out_root / Path(container_path).parent
        else:
            # no path info available -- fall back to grouping by type
            out_dir = out_root / "_no_container_path" / obj.type.name

        if not dry_run:
            out_dir.mkdir(parents=True, exist_ok=True)

        exported += export_object(obj, data, out_dir, name, dry_run)

    if total_objs == 0:
        print(f"  [EMPTY] 0 objects at all in this bundle")
    elif exported == 0:
        print(f"  [ALL-FAILED] {total_objs} object(s) present but every one "
              f"failed to read/export (see warnings above)")

    del env
    gc.collect()
    return exported


def _bundle_worker(bundle_path_str: str, out_root_str: str, dry_run: bool, queue: mp.Queue):
    """Runs in its own child process. If native code (e.g. the texture
    decoder) segfaults, only this child dies -- the parent driver loop
    keeps going."""
    try:
        n = export_bundle(Path(bundle_path_str), Path(out_root_str), dry_run)
        queue.put(("OK", n))
    except Exception as e:
        queue.put(("ERROR", str(e)))


def load_progress(progress_file: Path) -> set:
    if not progress_file.exists():
        return set()
    done = set()
    for line in progress_file.read_text().splitlines():
        if line.strip():
            done.add(line.split("\t", 1)[0])
    return done


def append_progress(progress_file: Path, bundle_name: str, status: str):
    with progress_file.open("a") as f:
        f.write(f"{bundle_name}\t{status}\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("bundle_dir", type=Path, help="folder containing .bundle files")
    ap.add_argument("--output", type=Path, required=True, help="output folder")
    ap.add_argument("--dry-run", action="store_true",
                     help="print what would be exported without writing files")
    ap.add_argument("--progress-file", type=Path, default=None,
                     help="defaults to <output>/.progress.log -- tracks which "
                          "bundles were already attempted so a crash or "
                          "Ctrl-C doesn't force a full restart")
    args = ap.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    progress_file = args.progress_file or (args.output / ".progress.log")

    done = load_progress(progress_file)
    if done:
        print(f"Resuming: {len(done)} bundle(s) already attempted previously, skipping those.")

    bundles = sorted(
        p for p in args.bundle_dir.rglob("*")
        if p.is_file()
        and p.stat().st_size > 0
        and not p.name.endswith((".manifest", ".meta", ".progress.log"))
    )
    bundles = [b for b in bundles if b.name not in done]
    print(f"{len(bundles)} bundle(s) left to process. No type/content filtering.")

    total = 0
    crashed = 0
    for i, b in enumerate(bundles, 1):
        print(f"[{i}/{len(bundles)}] {b.name}")

        q = mp.Queue()
        p = mp.Process(target=_bundle_worker, args=(str(b), str(args.output), args.dry_run, q))
        p.start()
        p.join()

        if p.exitcode != 0:
            print(f"  [CRASH] worker died (exit code {p.exitcode}), likely a native "
                  f"crash in texture/mesh decoding -- bundle skipped, moving on")
            append_progress(progress_file, b.name, "CRASH")
            crashed += 1
            continue

        try:
            status, payload = q.get_nowait()
        except Exception:
            status, payload = "UNKNOWN", 0

        if status == "OK":
            total += payload
            append_progress(progress_file, b.name, f"OK:{payload}")
        else:
            print(f"  [ERROR] {payload}")
            append_progress(progress_file, b.name, "ERROR")

    print(f"\nDone. {total} objects {'would be ' if args.dry_run else ''}exported. "
          f"{crashed} bundle(s) crashed and were skipped (see {progress_file}).")


if __name__ == "__main__":
    main()
