#!/usr/bin/env python3
"""
audit_realSuite.py
==================
Two tasks:
  1. Remove stray *_structured.xlsx files in the top-level of tests/realSuite/
     (i.e. Excel files that are NOT inside a test-case sub-folder).
  2. For every test folder, read input.xlsx and check each address against
     Nominatim. Report addresses that return NO results or are empty.

Nominatim ToS: max 1 request/second.  This script adds a 1.2-second sleep
between requests and uses a simple cache to avoid hitting the same query twice.
"""

import os
import sys
import glob
import time
import json
import requests
import pandas as pd
from pathlib import Path


# ── Config ──────────────────────────────────────────────────────────────────
REAL_SUITE_DIR = Path(__file__).parent / "realSuite"
SLEEP_BETWEEN_REQUESTS = 1.3   # seconds – safely below Nominatim 1 req/s limit
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
HEADERS = {"User-Agent": "BusPlan/1.0-audit (bus route optimizer for Trentino schools)"}
PARAMS_BASE = {
    "format": "json",
    "countrycodes": "it",
    "limit": 1,
    "viewbox": "10.4,45.6,12.2,46.95",
    "bounded": 0,
}

# simple in-memory cache  {query: bool}  (True = found)
_cache: dict[str, bool] = {}


# ── Helpers ──────────────────────────────────────────────────────────────────

def nominatim_has_results(address: str) -> bool:
    """Returns True if Nominatim returns at least one result for *address*."""
    key = address.strip().lower()
    if key in _cache:
        return _cache[key]

    time.sleep(SLEEP_BETWEEN_REQUESTS)
    try:
        resp = requests.get(
            NOMINATIM_URL,
            params={**PARAMS_BASE, "q": address},
            headers=HEADERS,
            timeout=8,
        )
        if resp.status_code == 429:
            print(f"  ⚠️  Rate-limited by Nominatim! Waiting 60 s …")
            time.sleep(60)
            return nominatim_has_results(address)  # retry once
        resp.raise_for_status()
        data = resp.json()
        found = len(data) > 0
    except Exception as exc:
        print(f"  ❌ Nominatim error for '{address}': {exc}")
        found = False

    _cache[key] = found
    return found


def read_addresses_from_excel(xlsx_path: Path) -> list[dict]:
    """
    Reads the input Excel and returns a list of dicts with keys:
      row_index, name, address
    Tries common column name variations.
    """
    df = pd.read_excel(xlsx_path)
    df.columns = [c.strip() for c in df.columns]

    # Try to find name / address columns (case-insensitive)
    col_map = {c.lower(): c for c in df.columns}

    name_col    = col_map.get("nome")    or col_map.get("name")    or col_map.get("scuola")
    address_col = col_map.get("indirizzo") or col_map.get("address") or col_map.get("addr")

    if not address_col:
        return []   # can't parse this file

    rows = []
    for idx, row in df.iterrows():
        name    = str(row[name_col]).strip()    if name_col    else f"row_{idx}"
        address = str(row[address_col]).strip() if address_col else ""
        rows.append({"row": idx, "name": name, "address": address})
    return rows


# ── Step 1: delete stray Excel files at root ─────────────────────────────────

def remove_stray_excels(dry_run: bool = False) -> list[Path]:
    removed = []
    for f in REAL_SUITE_DIR.glob("*.xlsx"):
        if dry_run:
            print(f"  [DRY RUN] would delete: {f.name}")
        else:
            f.unlink()
            print(f"  🗑️  Deleted: {f.name}")
        removed.append(f)
    return removed


# ── Step 2: audit addresses in every sub-folder ───────────────────────────────

def audit_folders() -> dict[str, list[dict]]:
    """
    Returns {folder_name: [{"name": …, "address": …, "issue": …}, …]}
    Only entries with problems are included.
    """
    results = {}

    test_dirs = sorted([
        d for d in REAL_SUITE_DIR.iterdir()
        if d.is_dir() and d.name != "pending"
    ])

    total_dirs = len(test_dirs)
    for i, folder in enumerate(test_dirs, 1):
        input_xlsx = folder / "input.xlsx"
        if not input_xlsx.exists():
            print(f"[{i}/{total_dirs}] {folder.name}: no input.xlsx — skipping")
            continue

        print(f"[{i}/{total_dirs}] Auditing {folder.name} …")
        rows = read_addresses_from_excel(input_xlsx)
        if not rows:
            print(f"  ⚠️  Could not parse columns in input.xlsx")
            continue

        problems = []
        for row in rows:
            addr = row["address"]
            if not addr or addr.lower() in ("nan", ""):
                problems.append({**row, "issue": "EMPTY"})
                continue
            found = nominatim_has_results(addr)
            if not found:
                problems.append({**row, "issue": "NOT FOUND"})

        if problems:
            results[folder.name] = problems
            for p in problems:
                print(f"  ❗ [{p['issue']}] {p['name']!r:40s} → {p['address']!r}")
        else:
            print(f"  ✅ All addresses found")

    return results


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    dry_run = "--dry-run" in sys.argv

    print("=" * 70)
    print("STEP 1 — Removing stray *_structured.xlsx from realSuite root")
    print("=" * 70)
    removed = remove_stray_excels(dry_run=dry_run)
    print(f"  → {len(removed)} file(s) {'would be ' if dry_run else ''}removed.\n")

    print("=" * 70)
    print("STEP 2 — Auditing addresses in each test folder via Nominatim")
    print("         (1.3 s sleep between requests to respect rate limit)")
    print("=" * 70)
    problems = audit_folders()

    print()
    print("=" * 70)
    print("SUMMARY")
    print("=" * 70)
    if not problems:
        print("✅ No address problems found across all test folders.")
    else:
        print(f"⚠️  {len(problems)} folder(s) with address issues:\n")
        for folder_name, entries in problems.items():
            print(f"  📁 {folder_name}")
            for e in entries:
                print(f"       [{e['issue']}] {e['name']!r} → {e['address']!r}")

    # Save JSON report
    report_path = REAL_SUITE_DIR.parent / "realSuite_audit_report.json"
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "stray_excels_deleted": [str(p.name) for p in removed],
                "address_problems": problems,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )
    print(f"\n📄 Report saved to: {report_path}")


if __name__ == "__main__":
    main()
