#!/usr/bin/env python3
"""
build_school_cache.py
=====================
Scans all test folders in tests/realSuite/ and extracts unique
(school_name, normalized_address) pairs into school_address_cache.json.

Run this after fix_addresses.py to keep the cache up to date.

Usage:
    python tests/build_school_cache.py
"""
import json
import pandas as pd
from pathlib import Path
from typing import Optional

REAL_SUITE_DIR = Path(__file__).parent / "realSuite"
CACHE_PATH = Path(__file__).parent.parent / "school_address_cache.json"


def _col(df: pd.DataFrame, *candidates) -> Optional[str]:
    col_map = {c.strip().lower(): c for c in df.columns}
    for c in candidates:
        if c.lower() in col_map:
            return col_map[c.lower()]
    return None


def build_cache() -> dict[str, str]:
    """Returns {school_name: normalized_address}"""
    cache: dict[str, str] = {}

    test_dirs = sorted([
        d for d in REAL_SUITE_DIR.iterdir()
        if d.is_dir() and d.name != "archive"
    ])

    for folder in test_dirs:
        # Prefer corretto (AI-corrected) if available
        src = (
            folder / "input_corretto.xlsx"
            if (folder / "input_corretto.xlsx").exists()
            else folder / "input.xlsx"
        )
        if not src.exists():
            continue

        try:
            df = pd.read_excel(src)
            df.columns = [c.strip() for c in df.columns]
        except Exception as e:
            print(f"  ⚠️  Could not read {src}: {e}")
            continue

        name_col = _col(df, "Nome", "name", "scuola")
        addr_col = _col(df, "Indirizzo", "address", "addr")
        if not addr_col:
            continue

        for _, row in df.iterrows():
            name = str(row[name_col]).strip() if name_col else ""
            addr = str(row[addr_col]).strip()
            if addr.lower() in ("nan", "none", ""):
                continue
            if name and name.lower() not in ("nan", "none", ""):
                cache[name] = addr  # later files overwrite earlier (prefer corretto)

    return cache


def main():
    print(f"Scanning {REAL_SUITE_DIR} …")
    cache = build_cache()
    with open(CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2, sort_keys=True)
    print(f"✅ Cache saved → {CACHE_PATH}  ({len(cache)} entries)")


if __name__ == "__main__":
    main()
