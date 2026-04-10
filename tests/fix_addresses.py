#!/usr/bin/env python3
"""
fix_addresses.py
================
Interactive tool that:
  1. Scans every test folder in tests/realSuite/ and collects all unique
     addresses that Nominatim cannot geocode (or that are empty).
  2. For each problematic address, shows where it appears and lets you type
     a corrected version — which is immediately validated against Nominatim.
  3. On confirmation, writes the fix into EVERY xlsx file that contains the
     bad address (both input.xlsx and input_corretto.xlsx if present).
  4. Also checks the 'destination' field in each config.json and allows the
     same interactive fix — saving directly back to the JSON.

Usage:
    python tests/fix_addresses.py [--dry-run]

Nominatim allows ~1 req/s. We sleep 1.3 s between requests.
"""

import os
import sys
import time
import json
import requests
import pandas as pd
from pathlib import Path
from collections import defaultdict

# ── Config ────────────────────────────────────────────────────────────────────
REAL_SUITE_DIR = Path(__file__).parent / "realSuite"
SLEEP = 1.3          # seconds between Nominatim requests
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
HEADERS = {"User-Agent": "BusPlan/1.0-audit (bus route optimizer for Trentino schools)"}
PARAMS_BASE = {
    "format": "json",
    "countrycodes": "it",
    "limit": 3,
    "viewbox": "10.4,45.6,12.2,46.95",
    "bounded": 0,
}
REPORT_PATH = REAL_SUITE_DIR.parent / "realSuite_fix_report.json"
DRY_RUN = "--dry-run" in sys.argv

# ── Nominatim ─────────────────────────────────────────────────────────────────
_cache: dict[str, list] = {}   # query -> list of result dicts


def query_nominatim(address: str) -> list:
    """Returns list of Nominatim result dicts (may be empty)."""
    key = address.strip().lower()
    if key in _cache:
        return _cache[key]

    time.sleep(SLEEP)
    try:
        resp = requests.get(
            NOMINATIM_URL,
            params={**PARAMS_BASE, "q": address},
            headers=HEADERS,
            timeout=8,
        )
        if resp.status_code == 429:
            print("  ⚠️  Rate-limited! Waiting 60 s …")
            time.sleep(60)
            _cache.pop(key, None)
            return query_nominatim(address)
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        print(f"  ❌ Nominatim error: {exc}")
        data = []

    _cache[key] = data
    return data


# ── Excel helpers ─────────────────────────────────────────────────────────────

def _col(df: pd.DataFrame, *candidates) -> str | None:
    col_map = {c.strip().lower(): c for c in df.columns}
    for c in candidates:
        if c.lower() in col_map:
            return col_map[c.lower()]
    return None


def read_xlsx(path: Path) -> pd.DataFrame:
    df = pd.read_excel(path)
    df.columns = [c.strip() for c in df.columns]
    return df


def get_addresses(df: pd.DataFrame) -> list[tuple[int, str, str]]:
    """Returns [(row_idx, name, address), …]"""
    addr_col = _col(df, "Indirizzo", "address", "addr")
    name_col = _col(df, "Nome", "name", "scuola")
    if not addr_col:
        return []
    rows = []
    for idx, row in df.iterrows():
        name = str(row[name_col]).strip() if name_col else f"row_{idx}"
        addr = str(row[addr_col]).strip()
        if addr.lower() in ("nan", "none", ""):
            addr = ""
        rows.append((idx, name, addr))
    return rows


def write_fix(xlsx_path: Path, old_addr: str, new_addr: str):
    """Replace every occurrence of old_addr with new_addr in the xlsx file."""
    df = read_xlsx(xlsx_path)
    addr_col = _col(df, "Indirizzo", "address", "addr")
    if not addr_col:
        return 0
    mask = df[addr_col].astype(str).str.strip() == old_addr
    count = mask.sum()
    if count and not DRY_RUN:
        df.loc[mask, addr_col] = new_addr
        df.to_excel(xlsx_path, index=False)
    return count


# ── Step 1: collect all problematic addresses ─────────────────────────────────

def collect_problems() -> dict[str, list[dict]]:
    """
    Returns {bad_address: [{"folder": …, "file": …, "name": …, "issue": …}, …]}
    """
    problems: dict[str, list] = defaultdict(list)

    test_dirs = sorted([
        d for d in REAL_SUITE_DIR.iterdir()
        if d.is_dir() and d.name != "archive"
    ])

    total = len(test_dirs)
    for i, folder in enumerate(test_dirs, 1):
        xlsx_files = [folder / "input.xlsx"]
        if (folder / "input_corretto.xlsx").exists():
            xlsx_files.append(folder / "input_corretto.xlsx")

        if not xlsx_files[0].exists():
            print(f"[{i}/{total}] {folder.name}: no input.xlsx — skipping")
            continue

        print(f"[{i}/{total}] Scanning {folder.name} …", end="", flush=True)

        # Use the most complete file as source
        source = xlsx_files[-1]  # prefer corretto if available
        df = read_xlsx(source)
        rows = get_addresses(df)
        bad_count = 0

        for (idx, name, addr) in rows:
            if not addr:
                problems[addr].append({"folder": folder.name, "file": str(source), "name": name, "issue": "EMPTY"})
                bad_count += 1
                continue

            results = query_nominatim(addr)
            if not results:
                problems[addr].append({"folder": folder.name, "file": str(source), "name": name, "issue": "NOT FOUND"})
                bad_count += 1

        if bad_count:
            print(f" ❗ {bad_count} problem(s)")
        else:
            print(f" ✅")

    return dict(problems)


# ── Step 1b: collect bad destinations from config.json ────────────────────────

def collect_destination_problems() -> dict[str, list[dict]]:
    """
    Returns {bad_destination: [{"folder": …, "config_path": …}, …]}
    Skips destinations that are empty or contain 'Unknown'.
    """
    problems: dict[str, list] = defaultdict(list)

    test_dirs = sorted([
        d for d in REAL_SUITE_DIR.iterdir()
        if d.is_dir() and d.name != "archive"
    ])

    total = len(test_dirs)
    for i, folder in enumerate(test_dirs, 1):
        cfg_path = folder / "config.json"
        if not cfg_path.exists():
            continue

        with open(cfg_path, encoding="utf-8") as f:
            cfg = json.load(f)

        dest = cfg.get("destination", "").strip()
        if not dest or dest.lower() == "unknown":
            print(f"[{i}/{total}] {folder.name}: destination EMPTY/Unknown — flagged")
            problems[dest].append({"folder": folder.name, "config_path": str(cfg_path)})
            continue

        print(f"[{i}/{total}] Checking destination for {folder.name} …", end="", flush=True)
        results = query_nominatim(dest)
        if not results:
            print(f" ❗ NOT FOUND")
            problems[dest].append({"folder": folder.name, "config_path": str(cfg_path)})
        else:
            print(f" ✅")

    return dict(problems)


def write_destination_fix(config_path: Path, new_dest: str):
    """Update the destination field in a config.json file."""
    with open(config_path, encoding="utf-8") as f:
        cfg = json.load(f)
    if not DRY_RUN:
        cfg["destination"] = new_dest
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)


def interactive_fix_destinations(problems: dict[str, list[dict]], report: dict) -> dict:
    """Walk through each bad destination interactively. Updates report in-place and saves after each fix."""
    fixes_applied = {}

    total = len(problems)
    print()
    print("=" * 70)
    print(f"Found {total} problematic destination(s) in config.json files.")
    print("Commands: <new address>  |  s = skip  |  q = quit")
    print("=" * 70)

    for n, (bad_dest, occurrences) in enumerate(problems.items(), 1):
        print()
        issue = "EMPTY/Unknown" if not bad_dest or bad_dest.lower() == "unknown" else "NOT FOUND"
        print(f"[{n}/{total}] ── {repr(bad_dest) if bad_dest else 'EMPTY'} ({issue})")
        print(f"  Appears in {len(occurrences)} folder(s):")
        for occ in occurrences:
            print(f"    • {occ['folder']}")

        while True:
            try:
                user_input = input("\n  ✏️  New destination (or s=skip, q=quit): ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\nAborted.")
                return fixes_applied

            if user_input.lower() == "q":
                print("Quitting early.")
                return fixes_applied

            if user_input.lower() in ("s", ""):
                print("  ⏭️  Skipped.")
                break

            print(f"  🔍 Checking '{user_input}' …", end="", flush=True)
            results = query_nominatim(user_input)
            if not results:
                print(" ❌ Not found. Try again.")
                continue

            print(f" ✅ Found {len(results)} result(s):")
            for r in results[:3]:
                print(f"      → {r['display_name']}")

            confirm = input("  Use this destination? [Y/n]: ").strip().lower()
            if confirm in ("", "y", "yes"):
                updated_files = []
                for occ in occurrences:
                    cfg_path = Path(occ["config_path"])
                    write_destination_fix(cfg_path, user_input)
                    tag = "[DRY RUN] " if DRY_RUN else ""
                    print(f"    {tag}📝 {cfg_path.relative_to(REAL_SUITE_DIR.parent)}: destination updated")
                    updated_files.append(str(cfg_path))

                fixes_applied[bad_dest] = {
                    "new_destination": user_input,
                    "nominatim_match": results[0]["display_name"],
                    "files_updated": updated_files,
                }
                report["destination_fixes"] = fixes_applied
                _save_report(report)
                print(f"  ✅ Fixed in {len(updated_files)} config file(s). [report saved]")
                break
            else:
                print("  ↩️  Discarded. Try again.")

    return fixes_applied


# ── Step 2: interactive fix loop ──────────────────────────────────────────────

# ── Report helper ───────────────────────────────────────────────────────────────────

class _Enc(json.JSONEncoder):
    def default(self, obj):
        if hasattr(obj, "item"):   # numpy scalar
            return obj.item()
        return super().default(obj)


def _save_report(report: dict):
    """Write the current report dict to disk immediately."""
    with open(REPORT_PATH, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2, cls=_Enc)


def interactive_fix(problems: dict[str, list[dict]], report: dict) -> dict:
    """Walk through each bad address interactively. Updates report in-place and saves after each fix."""
    fixes_applied = {}

    total = len(problems)
    print()
    print("=" * 70)
    print(f"Found {total} unique problematic address(es). Let's fix them.")
    print("Commands: <new address>  |  s = skip  |  q = quit")
    print("=" * 70)

    for n, (bad_addr, occurrences) in enumerate(problems.items(), 1):
        issue = occurrences[0]["issue"]
        print()
        print(f"[{n}/{total}] ── {'EMPTY' if not bad_addr else repr(bad_addr)} ({issue})")
        print(f"  Appears in {len(occurrences)} place(s):")
        for occ in occurrences:
            print(f"    • {occ['folder']}  →  {occ['name']!r}")

        while True:
            try:
                user_input = input("\n  ✏️  New address (or s=skip, q=quit): ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\nAborted.")
                return fixes_applied

            if user_input.lower() == "q":
                print("Quitting early.")
                return fixes_applied

            if user_input.lower() in ("s", ""):
                print("  ⏭️  Skipped.")
                break

            # Validate with Nominatim
            print(f"  🔍 Checking '{user_input}' …", end="", flush=True)
            results = query_nominatim(user_input)
            if not results:
                print(" ❌ Not found. Try again.")
                continue

            # Show found candidates
            print(f" ✅ Found {len(results)} result(s):")
            for r in results[:3]:
                print(f"      → {r['display_name']}")

            confirm = input("  Use this address? [Y/n]: ").strip().lower()
            if confirm in ("", "y", "yes"):
                # Apply fix to all xlsx files containing the bad address
                all_files: set[Path] = set()
                for occ in occurrences:
                    folder = REAL_SUITE_DIR / occ["folder"]
                    for fname in ("input.xlsx", "input_corretto.xlsx", "groundtruth.xlsx"):
                        fpath = folder / fname
                        if fpath.exists():
                            all_files.add(fpath)

                total_cells = 0
                for fpath in sorted(all_files):
                    count = write_fix(fpath, bad_addr, user_input)
                    if count:
                        tag = "[DRY RUN] " if DRY_RUN else ""
                        print(f"    {tag}📝 {fpath.relative_to(REAL_SUITE_DIR.parent)}: {count} cell(s) updated")
                        total_cells += count

                fixes_applied[bad_addr] = {
                    "new_address": user_input,
                    "nominatim_match": results[0]["display_name"],
                    "files_updated": [str(f) for f in sorted(all_files)],
                    "cells_updated": int(total_cells),
                }
                report["xlsx_fixes"] = fixes_applied
                _save_report(report)
                print(f"  ✅ Fixed in {total_cells} cell(s) across {len(all_files)} file(s). [report saved]")
                break
            else:
                print("  ↩️  Discarded. Try again.")

    return fixes_applied


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if DRY_RUN:
        print("⚠️  DRY RUN — no files will be modified.\n")

    # ── Phase 1: xlsx addresses ──
    print("=" * 70)
    print("PHASE 1 — Scanning input.xlsx addresses via Nominatim")
    print(f"          (1.3 s sleep between requests)")
    print("=" * 70)
    addr_problems = collect_problems()

    addr_fixes = {}
    dest_fixes = {}

    # Shared report dict — updated and saved after every confirmed fix
    report = {
        "xlsx_fixes": addr_fixes,
        "xlsx_remaining": {},
        "destination_fixes": dest_fixes,
        "destination_remaining": {},
    }

    if not addr_problems:
        print("\n✅ No xlsx address problems found.")
    else:
        print(f"\n📋 {len(addr_problems)} unique bad address(es) collected.")
        addr_fixes = interactive_fix(addr_problems, report)

    # ── Phase 2: config.json destinations ──
    print()
    print("=" * 70)
    print("PHASE 2 — Scanning config.json destinations via Nominatim")
    print("=" * 70)
    dest_problems = collect_destination_problems()

    if not dest_problems:
        print("\n✅ No destination problems found.")
    else:
        print(f"\n📋 {len(dest_problems)} problematic destination(s) collected.")
        dest_fixes = interactive_fix_destinations(dest_problems, report)

    # ── Final report save ──
    report["xlsx_remaining"]       = {k: v for k, v in addr_problems.items() if k not in addr_fixes}
    report["destination_remaining"] = {k: v for k, v in dest_problems.items() if k not in dest_fixes}
    _save_report(report)

    print()
    print("=" * 70)
    print("DONE")
    print(f"  xlsx fixed:          {len(addr_fixes)} address(es)")
    print(f"  xlsx remaining:      {len(report['xlsx_remaining'])} address(es)")
    print(f"  dest fixed:          {len(dest_fixes)} destination(s)")
    print(f"  dest remaining:      {len(report['destination_remaining'])} destination(s)")
    print(f"  Report:              {REPORT_PATH}")
    print("=" * 70)


if __name__ == "__main__":
    main()
