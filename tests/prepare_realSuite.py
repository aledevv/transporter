"""
Prepare realSuite test cases.

Usage:
  python tests/prepare_realSuite.py --extract          # Step 1: extract input.xlsx + groundtruth.xlsx
  python tests/prepare_realSuite.py --correct          # Step 2: AI-correct addresses (run once)
  python tests/prepare_realSuite.py --geocode          # Step 3: geocode + build time_matrix.json
  python tests/prepare_realSuite.py                    # Run all steps in sequence
"""
import argparse
import json
import math
import shutil
import sys
import warnings
from pathlib import Path

import pandas as pd

TESTS_DIR = Path(__file__).parent
REALSUITE_DIR = TESTS_DIR / "realSuite"
PENDING_DIR = REALSUITE_DIR / "pending"

# -----------------------------------------------------------------------
# Pure helper functions (unit-testable)
# -----------------------------------------------------------------------

def extract_schools_from_structured(xlsx_path: Path) -> pd.DataFrame:
    """
    Read the 'Per Istituto' sheet and return a DataFrame with columns:
      Nome, Indirizzo, Partecipanti
    Drops rows where any of these is null/empty.
    Deduplicates by (Nome, Indirizzo), summing Partecipanti.
    NO Istituto grouping column — planner must discover proximity itself.
    """
    df = pd.read_excel(xlsx_path, sheet_name="Per Istituto")
    df.columns = [c.strip() for c in df.columns]

    out = pd.DataFrame({
        "Nome": df["Istituto"].astype(str).str.strip(),
        "Indirizzo": df["Luogo Ritrovo"].astype(str).str.strip(),
        "Partecipanti": pd.to_numeric(df["Persone"], errors="coerce"),
    })

    # Drop rows with missing or empty values
    out = out[out["Nome"].notna() & (out["Nome"] != "") & (out["Nome"].str.lower() != "nan")]
    out = out[out["Indirizzo"].notna() & (out["Indirizzo"] != "") & (out["Indirizzo"].str.lower() != "nan")]
    out = out[out["Partecipanti"].notna()]

    # Deduplicate: same (Nome, Indirizzo) → sum Partecipanti
    out = out.groupby(["Nome", "Indirizzo"], as_index=False).agg({"Partecipanti": "sum"})
    out["Partecipanti"] = out["Partecipanti"].astype(int)

    return out.reset_index(drop=True)


def get_event_destination(xlsx_path: Path) -> str:
    """
    Return the destination string from the 'Per Istituto' sheet.
    Takes the first non-null value from the 'Destinazione' column.
    """
    df = pd.read_excel(xlsx_path, sheet_name="Per Istituto")
    df.columns = [c.strip() for c in df.columns]
    col = df["Destinazione"].dropna()
    col = col[col.astype(str).str.lower() != "nan"]
    if col.empty:
        return "Unknown"
    return str(col.iloc[0]).strip()


# -----------------------------------------------------------------------
# Phase 1: Extract
# -----------------------------------------------------------------------

def _event_name(xlsx_path: Path) -> str:
    """Folder name for an event: filename without '_structured.xlsx'."""
    return xlsx_path.stem.replace("_structured", "")


def _get_capacity(xlsx_path: Path) -> int:
    """
    Return the standard bus capacity for test cases.
    NOTE: 'Totale PAX Bus' in the groundtruth stores actual bus *load*, not physical
    capacity. We use 54 (standard Trentino school bus) unconditionally.
    """
    return 54


def _get_fine_manifestazione(xlsx_path: Path) -> str | None:
    """
    Extract event end time from 'Dettaglio Completo' sheet, 'Fine Manifestazione' column.
    Returns HH:MM string or None if absent.
    """
    import datetime
    try:
        df = pd.read_excel(xlsx_path, sheet_name="Dettaglio Completo")
        df.columns = [c.strip() for c in df.columns]
        if "Fine Manifestazione" in df.columns:
            col = df["Fine Manifestazione"].dropna()
            col = col[col.astype(str).str.lower() != "nan"]
            if not col.empty:
                val_raw = col.iloc[0]
                # Handle datetime objects before stringifying
                if isinstance(val_raw, datetime.time):
                    return val_raw.strftime("%H:%M")
                if hasattr(val_raw, 'strftime'):  # pd.Timestamp or datetime
                    return val_raw.strftime("%H:%M")
                val = str(val_raw).strip()
                # Normalize to HH:MM
                if ":" in val:
                    return val[:5]
    except Exception:
        pass
    return None


def run_extract():
    """Phase 1: extract input.xlsx + groundtruth.xlsx + config.json for each event."""
    structured_files = sorted(
        f for f in REALSUITE_DIR.glob("*_structured.xlsx")
        if not f.is_relative_to(PENDING_DIR)
    )

    if not structured_files:
        print("No _structured.xlsx files found in tests/realSuite/")
        return

    for xlsx in structured_files:
        name = _event_name(xlsx)
        out_dir = REALSUITE_DIR / name
        out_dir.mkdir(exist_ok=True)

        # Write input.xlsx
        df = extract_schools_from_structured(xlsx)
        df.to_excel(out_dir / "input.xlsx", index=False)

        # Copy groundtruth
        shutil.copy2(xlsx, out_dir / "groundtruth.xlsx")

        # Write config.json
        config = {
            "destination": get_event_destination(xlsx),
            "capacity": _get_capacity(xlsx),
            "orario_fine_manifestazione": _get_fine_manifestazione(xlsx),
        }
        (out_dir / "config.json").write_text(
            json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        print(f"[extract] {name}: {len(df)} schools → {out_dir}")

    print(f"\nExtraction complete: {len(structured_files)} events.")


# -----------------------------------------------------------------------
# Phase 2 and 3 stubs (implemented in later tasks)
# -----------------------------------------------------------------------

def run_correct():
    print("[correct] Not yet implemented — run after Task 5.")


def run_geocode():
    print("[geocode] Not yet implemented — run after Task 6.")


# -----------------------------------------------------------------------
# CLI entry point
# -----------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Prepare realSuite test cases")
    parser.add_argument("--extract", action="store_true", help="Extract input.xlsx files")
    parser.add_argument("--correct", action="store_true", help="AI-correct addresses")
    parser.add_argument("--geocode", action="store_true", help="Geocode + build time matrices")
    args = parser.parse_args()

    run_all = not any([args.extract, args.correct, args.geocode])

    if args.extract or run_all:
        run_extract()
    if args.correct or run_all:
        run_correct()
    if args.geocode or run_all:
        run_geocode()
