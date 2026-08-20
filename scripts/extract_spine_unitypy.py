#!/usr/bin/env python3
"""
Fallback Spine extractor using UnityPy (when ba_spine_extractor.py is missing).
Extracts TextAsset (.skel/.atlas/.json) and Texture2D (.png) from AssetBundles
into JP_EXTRACT/Assets/_MX/SpineLobbies/<lobby>/

Usage: python scripts/extract_spine_unitypy.py <bundle_dir> --output <out_dir> [--workers 8]
"""
import argparse
import os
import sys
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed

def extract_bundle(bundle_path: Path, output_root: Path):
    try:
        import UnityPy
    except ImportError:
        return f"UnityPy not installed, skip {bundle_path.name}"
    try:
        env = UnityPy.load(str(bundle_path))
    except Exception as e:
        return f"skip {bundle_path.name}: load failed {e}"

    # Determine lobby name from bundle path (e.g., spine_lobby_a01.bundle -> a01)
    # Keep original bundle stem as folder name; copy_assets.py will handle filtering
    # Output to Assets/_MX/SpineLobbies/<bundle_stem>/
    bundle_stem = bundle_path.stem
    # Try to infer lobby name: if bundle contains Spine, use stem
    out_base = output_root / "Assets" / "_MX" / "SpineLobbies" / bundle_stem
    extracted = 0
    for obj in env.objects:
        try:
            if obj.type.name == "TextAsset":
                data = obj.read()
                name = data.name
                # TextAsset script contains bytes
                script = data.script
                if isinstance(script, str):
                    script = script.encode("utf-8", errors="ignore")
                # Determine extension: if name contains .skel/.atlas/.json else use .bytes
                # Save as name (keep original)
                # If name has no extension, try to guess from content
                fname = name
                if "." not in fname:
                    # Heuristic: check header
                    if script[:4] == b"PK\x03\x04":
                        continue
                    # Default to .skel if binary
                    fname = name + ".skel"
                out_path = out_base / fname
                out_path.parent.mkdir(parents=True, exist_ok=True)
                with open(out_path, "wb") as f:
                    f.write(script if isinstance(script, bytes) else script.encode())
                extracted += 1
            elif obj.type.name == "Texture2D":
                data = obj.read()
                name = data.name
                try:
                    img = data.image
                    out_path = out_base / (name + ".png")
                    out_path.parent.mkdir(parents=True, exist_ok=True)
                    img.save(out_path)
                    extracted += 1
                except Exception:
                    # Fallback: save raw
                    pass
        except Exception:
            continue
    if extracted:
        return f"{bundle_path.name}: {extracted} files -> {out_base}"
    return None

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="AssetBundles directory")
    parser.add_argument("--output", required=True, help="Output root (JP_EXTRACT)")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    bundle_dir = Path(args.input)
    output_root = Path(args.output)

    if not bundle_dir.exists():
        print(f"Input not found: {bundle_dir}", file=sys.stderr)
        sys.exit(1)

    bundles = [p for p in bundle_dir.rglob("*") if p.is_file() and p.stat().st_size > 0]
    # Filter to likely AssetBundles (no extension or .bundle)
    # Keep all for now, but skip obvious non-bundles (like .manifest)
    bundles = [p for p in bundles if not p.name.endswith(".manifest") and not p.name.endswith(".meta")]

    print(f"Found {len(bundles)} bundles in {bundle_dir}")
    if not bundles:
        print("No bundles found, skipping", file=sys.stderr)
        return

    output_root.mkdir(parents=True, exist_ok=True)

    # Use ProcessPool for speed, fallback to sequential if workers=1
    if args.workers > 1:
        with ProcessPoolExecutor(max_workers=args.workers) as ex:
            futures = {ex.submit(extract_bundle, b, output_root): b for b in bundles}
            for fut in as_completed(futures):
                res = fut.result()
                if res:
                    print(res)
    else:
        for b in bundles:
            res = extract_bundle(b, output_root)
            if res:
                print(res)

    # Count results
    spine_root = output_root / "Assets" / "_MX" / "SpineLobbies"
    if spine_root.exists():
        lobbies = [d for d in spine_root.iterdir() if d.is_dir()]
        print(f"Done: {len(lobbies)} lobbies extracted to {spine_root}")
    else:
        print(f"Warning: no SpineLobbies extracted to {spine_root}", file=sys.stderr)

if __name__ == "__main__":
    main()
