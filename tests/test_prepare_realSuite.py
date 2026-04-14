"""Unit tests for prepare_realSuite helper functions."""
from pathlib import Path
import pandas as pd
import pytest

# We test against a known structured file in realSuite
REALSUITE = Path(__file__).parent / "realSuite"
# Pick the first structured xlsx (now lives in archive/ after prepare_realSuite.py ran)
SAMPLE = sorted((REALSUITE / "archive").glob("*_structured.xlsx"))[0]


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


# Padel ha IS GUETTI (Luogo Ritrovo=NaN) e IS FILZI ROVERETO (Luogo Ritrovo=NaN)
PADEL = REALSUITE / "archive" / "Piani-viaggio_Padel_10-dic-25_def2_con-VETTORE_structured.xlsx"

def test_extract_schools_includes_grouped_schools():
    """Scuole con Luogo Ritrovo vuoto ereditano l'indirizzo del predecessore."""
    from prepare_realSuite import extract_schools_from_structured
    df = extract_schools_from_structured(PADEL)
    names = df["Nome"].tolist()
    assert "IS GUETTI" in names, f"IS GUETTI mancante; scuole trovate: {names}"
    assert "IS FILZI ROVERETO" in names, f"IS FILZI ROVERETO mancante; scuole trovate: {names}"

def test_extract_schools_grouped_school_inherits_address():
    """IS GUETTI eredita l'indirizzo di IS ENAIP di TIONE."""
    from prepare_realSuite import extract_schools_from_structured
    df = extract_schools_from_structured(PADEL)
    guetti = df[df["Nome"] == "IS GUETTI"]
    assert len(guetti) == 1
    expected = "Tione, Via Durone 53 – fermata davanti alla scuola I.I.L. Guetti"
    assert guetti.iloc[0]["Indirizzo"] == expected, (
        f"Indirizzo errato: {guetti.iloc[0]['Indirizzo']!r}"
    )

def test_extract_schools_grouped_school_zero_demand():
    """IS GUETTI ha Persone=NaN → Partecipanti=0."""
    from prepare_realSuite import extract_schools_from_structured
    df = extract_schools_from_structured(PADEL)
    guetti = df[df["Nome"] == "IS GUETTI"]
    assert guetti.iloc[0]["Partecipanti"] == 0

def test_extract_schools_grouped_school_with_demand():
    """IS FILZI ROVERETO ha Persone=9 → Partecipanti=9."""
    from prepare_realSuite import extract_schools_from_structured
    df = extract_schools_from_structured(PADEL)
    filzi = df[df["Nome"] == "IS FILZI ROVERETO"]
    assert filzi.iloc[0]["Partecipanti"] == 9
