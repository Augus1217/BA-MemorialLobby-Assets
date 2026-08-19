#!/usr/bin/env python3
"""
Extract voice_index.json from voice folder listing.

Scans assets/voice/JP_*/ directories and builds a mapping of
character_id -> [ogg files] for MemorialLobby voice events.

Usage:
    python3 extract_voice_index.py [--voice-dir PATH] [--output PATH]
"""

import argparse
import json
import os
import sys


def extract_voice_index(voice_dir: str) -> dict:
    """Scan voice directories and build voice index."""
    index = {}

    if not os.path.isdir(voice_dir):
        print(f"Error: voice directory not found: {voice_dir}", file=sys.stderr)
        return index

    for folder_name in sorted(os.listdir(voice_dir)):
        if not folder_name.startswith("JP_"):
            continue

        folder_path = os.path.join(voice_dir, folder_name)
        if not os.path.isdir(folder_path):
            continue

        # Extract character ID from folder name
        # JP_Airi -> Airi, JP_CH0070 -> CH0070
        char_id = folder_name[3:]  # strip "JP_"

        # List only memoriallobby .ogg files
        ogg_files = sorted([
            f for f in os.listdir(folder_path)
            if f.endswith(".ogg") and "memoriallobby" in f
        ])

        if ogg_files:
            index[char_id] = ogg_files

    return index


def main():
    parser = argparse.ArgumentParser(description="Extract voice_index.json")
    parser.add_argument("--voice-dir", default="assets/voice",
                        help="Path to voice directory (default: assets/voice)")
    parser.add_argument("--output", default=None,
                        help="Output JSON path (default: stdout)")
    args = parser.parse_args()

    index = extract_voice_index(args.voice_dir)

    output = json.dumps(index, ensure_ascii=False, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output)
        print(f"Written {len(index)} entries to {args.output}")
    else:
        print(output)

    return 0


if __name__ == "__main__":
    sys.exit(main())
