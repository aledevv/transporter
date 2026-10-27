"""Tests for tools/merge_institutes.build_merge (no Firestore access)."""
from tools.merge_institutes import build_merge, normalize_for_compare


def test_dropped_names_become_aliases_of_kept_entry():
    keep = {"name": "IS DON MILANI ROVERETO", "aliases": []}
    drops = [{"name": "IC Rovereto Est"}, {"name": "IC ALTA VALLAGARINA - Besenello"}]
    assert build_merge(keep, drops) == ["IC Rovereto Est", "IC ALTA VALLAGARINA - Besenello"]


def test_duplicates_are_skipped_ignoring_case_and_accents():
    keep = {"name": "ENAIP TIONE", "aliases": ["IS Guetti Tione"]}
    drops = [
        {"name": "Enaip Tione"},                       # same as kept name
        {"name": "IS GUETTI TIONE", "aliases": ["IS Guètti  Tione", "Autostazione Tione"]},
    ]
    assert build_merge(keep, drops) == ["IS Guetti Tione", "Autostazione Tione"]


def test_original_names_and_blanks():
    keep = {"name": "IC LADINO DI FASSA", "originalName": "IC LADINO DI FASSA (San Giovanni)"}
    drops = [{"name": "IS LADINO DI FASSA", "originalName": "IS LADINO DI FASSA (Pozza)", "aliases": ["", None]}]
    assert build_merge(keep, drops) == ["IS LADINO DI FASSA", "IS LADINO DI FASSA (Pozza)"]


def test_normalize_for_compare():
    assert normalize_for_compare("  IS Guètti – Tione ") == "is guetti tione"
