#!/usr/bin/env python3
"""
Extract students_data.csv from external data source.

Downloads from the BA-characters-internal-id project:
https://agent-0808.github.io/BA-characters-internal-id/data/students_data.csv

This is a third-party maintained dataset with student metadata
(names, spine IDs, school info, etc.) that cannot be extracted
from ExcelDB alone.

Usage:
    python3 extract_students.py [--output PATH]
"""

import argparse
import sys
import urllib.request


SOURCE_URL = "https://agent-0808.github.io/BA-characters-internal-id/data/students_data.csv"


def extract_students(output_path: str) -> bool:
    """Download students_data.csv from external source."""
    try:
        print(f"Downloading from {SOURCE_URL} ...", file=sys.stderr)
        req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "BA-MemorialLobby/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read().decode("utf-8-sig")

        with open(output_path, "w", encoding="utf-8-sig") as f:
            f.write(data)

        lines = data.strip().split("\n")
        print(f"Downloaded {len(lines) - 1} entries to {output_path}", file=sys.stderr)
        return True
    except Exception as e:
        print(f"Error downloading: {e}", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(description="Extract students_data.csv")
    parser.add_argument("--output", default="assets/data/students_data.csv",
                        help="Output CSV path")
    args = parser.parse_args()

    ok = extract_students(args.output)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
