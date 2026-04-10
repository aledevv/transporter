"""Unit tests for prepare_realSuite helper functions."""
from pathlib import Path
import pandas as pd
import pytest

# We test against a known structured file in realSuite
REALSUITE = Path(__file__).parent / "realSuite"
# Pick the first non-pending structured xlsx
SAMPLE = sorted(REALSUITE.glob("*_structured.xlsx"))[0]


def test_extract_schools_returns_required_columns():
    from prepare_realSuite import extract_schools_from_structured
    df = extract_schools_from_structured(SAMPLE)
    assert set(df.columns) >= {"Nome", "Indirizzo", "Partecipanti"}


def test_extract_schools_drops_null_rows():
    from prepare_realSuite import extract_schools_from_structured
    df = extract_schools_from_structured(SAMPLE)
    assert df["Nome"].notna().all()
    assert df["Indirizzo"].notna().all()
    assert df["Partecipanti"].notna().all()


def test_extract_schools_partecipanti_is_int():
    from prepare_realSuite import extract_schools_from_structured
    df = extract_schools_from_structured(SAMPLE)
    assert df["Partecipanti"].dtype in (int, "int64", "int32")


def test_get_event_destination_returns_string():
    from prepare_realSuite import get_event_destination
    dest = get_event_destination(SAMPLE)
    assert isinstance(dest, str) and len(dest) > 0


def test_extract_schools_no_istituto_column():
    """Planner Istituto column must be absent — no pre-grouping bias."""
    from prepare_realSuite import extract_schools_from_structured
    df = extract_schools_from_structured(SAMPLE)
    assert "Istituto" not in df.columns
