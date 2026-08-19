#!/usr/bin/env python3
"""
Extract lobby_subtitle.json — partial automation.

The subtitle TEXT cannot be auto-extracted from ExcelDB tables because
it lives in the game's scenario/dialogue system, not in any accessible
database table. The GL CharacterDialogSubtitleDB uses different naming
(CVGroup_UISpecialOperationLobby_*) and doesn't cover MemorialLobby events.

This script:
1. Reads the EXISTING lobby_subtitle.json (preserves all existing text)
2. Scans VoiceSpineDB for new MemorialLobby events not yet in the file
3. Adds new entries with empty text (to be filled manually)

Usage:
    python3 extract_subtitles.py [--gl-table PATH] [--existing PATH] [--output PATH]
"""

import argparse
import json
import os
import sys


def load_exceldb_schema(schema_path: str) -> list:
    """Load an ExcelDB schema JSON and return the entries list."""
    with open(schema_path, "r", encoding="utf-8") as f:
        return json.load(f)


def extract_spine_event_name(path: str) -> str:
    """Extract spine event name from audio path.
    
    e.g., "Audio/VOC_JP/JP_Airi/Airi_MemorialLobby_1_1" -> "Airi_MemorialLobby_1_1"
    """
    name = path.rsplit("/", 1)[-1] if "/" in path else path
    if name.endswith(".ogg"):
        name = name[:-4]
    return name


def get_new_events(gl_table_dir: str, existing: dict) -> list:
    """Find MemorialLobby events in VoiceSpineDB not yet in existing subtitles."""
    voice_spine_path = os.path.join(gl_table_dir, "VoiceSpineDBSchema.json")
    if not os.path.exists(voice_spine_path):
        print(f"Warning: VoiceSpineDB not found: {voice_spine_path}", file=sys.stderr)
        return []

    voice_spine = load_exceldb_schema(voice_spine_path)
    new_events = []

    for e in voice_spine:
        b = e.get("Bytes", {})
        paths = b.get("Path", [])
        if not paths:
            continue

        jp_path = paths[0] if isinstance(paths, list) else paths
        if not isinstance(jp_path, str):
            continue

        event_name = extract_spine_event_name(jp_path)
        if not event_name or "MemorialLobby" not in event_name:
            continue

        if event_name not in existing:
            new_events.append(event_name)

    return sorted(new_events)


def main():
    parser = argparse.ArgumentParser(description="Extract lobby_subtitle.json")
    parser.add_argument("--gl-table", default=None,
                        help="Path to GL ExcelDB schema directory")
    parser.add_argument("--existing", default="assets/data/lobby_subtitle.json",
                        help="Path to existing lobby_subtitle.json")
    parser.add_argument("--output", default=None,
                        help="Output JSON path (default: stdout)")
    args = parser.parse_args()

    # Load existing subtitles
    existing = {}
    if os.path.exists(args.existing):
        with open(args.existing, "r", encoding="utf-8") as f:
            existing = json.load(f)
        print(f"Loaded {len(existing)} existing entries", file=sys.stderr)

    # Find new events
    new_events = []
    if args.gl_table:
        new_events = get_new_events(args.gl_table, existing)
        print(f"Found {len(new_events)} new events not in existing file", file=sys.stderr)
    else:
        print("No --gl-table specified, only preserving existing data", file=sys.stderr)

    # Add new events with empty text
    result = dict(existing)
    for event_name in new_events:
        result[event_name] = {"jp": "", "tw": "", "en": "", "kr": ""}

    output = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output)
        print(f"Written {len(result)} entries to {args.output}", file=sys.stderr)
    else:
        print(output)

    return 0


if __name__ == "__main__":
    sys.exit(main())
