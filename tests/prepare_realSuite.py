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
