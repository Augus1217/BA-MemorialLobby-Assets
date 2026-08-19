#!/usr/bin/env python3
"""
Extract lobby_bgm_mapping.csv from ExcelDB tables.

Joins MemoryLobbyDB (PrefabName, CharacterId, BGMId) with BGMDB (Id -> Path)
to produce: prefab, name, char_id, bgm_id, bgm_filename

Usage:
    python3 extract_bgm_mapping.py [--jp-table PATH] [--output PATH]
"""

import argparse
import csv
import json
import os
import sys


def load_exceldb_schema(schema_path: str) -> list:
    """Load an ExcelDB schema JSON and return the entries list."""
    with open(schema_path, "r", encoding="utf-8") as f:
        return json.load(f)


def extract_bgm_mapping(jp_table_dir: str) -> list:
    """Extract lobby BGM mapping from MemoryLobbyDB + BGMDB."""
    # Load MemoryLobbyDB
    memory_lobby_path = os.path.join(jp_table_dir, "MemoryLobbyDBSchema.json")
    if not os.path.exists(memory_lobby_path):
        print(f"Error: MemoryLobbyDB not found: {memory_lobby_path}", file=sys.stderr)
        return []

    memory_lobby = load_exceldb_schema(memory_lobby_path)

    # Load BGMDB for filename mapping
    bgm_db_path = os.path.join(jp_table_dir, "BGMDBSchema.json")
    bgm_db = {}
    if os.path.exists(bgm_db_path):
        bgm_entries = load_exceldb_schema(bgm_db_path)
        for e in bgm_entries:
            b = e.get("Bytes", {})
            bgm_id = b.get("Id")
            path = b.get("Path", [""])[0] if isinstance(b.get("Path"), list) else b.get("Path", "")
            if bgm_id is not None:
                # Extract filename from path like "Audio/BGM/Theme_38"
                filename = path.rsplit("/", 1)[-1] + ".ogg" if "/" in path else path + ".ogg"
                bgm_db[bgm_id] = filename

    # Build mapping
    rows = []
    for entry in memory_lobby:
        b = entry.get("Bytes", {})
        char_id = b.get("CharacterId")
        prefab = b.get("PrefabName", "")
        bgm_id = b.get("BGMId")

        if not prefab or not char_id:
            continue

        bgm_filename = bgm_db.get(bgm_id, "") if bgm_id else ""

        # Extract character name from PrefabName (e.g., "LobbyAru" -> "Aru")
        name = prefab.replace("Lobby", "") if prefab.startswith("Lobby") else prefab

        rows.append({
            "prefab": prefab,
            "name": name,
            "char_id": char_id,
            "bgm_id": bgm_id or "",
            "bgm_filename": bgm_filename,
        })

    return rows


def main():
    parser = argparse.ArgumentParser(description="Extract lobby_bgm_mapping.csv")
    parser.add_argument("--jp-table", default="assets/data",
                        help="Path to JP ExcelDB schema directory")
    parser.add_argument("--output", default=None,
                        help="Output CSV path (default: stdout)")
    args = parser.parse_args()

    rows = extract_bgm_mapping(args.jp_table)

    if args.output:
        with open(args.output, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=["prefab", "name", "char_id", "bgm_id", "bgm_filename"])
            writer.writeheader()
            writer.writerows(rows)
        print(f"Written {len(rows)} rows to {args.output}")
    else:
        # Print as CSV to stdout
        import io
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=["prefab", "name", "char_id", "bgm_id", "bgm_filename"])
        writer.writeheader()
        writer.writerows(rows)
        print(output.getvalue())

    return 0


if __name__ == "__main__":
    sys.exit(main())
