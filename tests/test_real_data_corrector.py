"""
Tests using real address data extracted from tests/real1/input.xlsx and
tests/real2/input.xlsx.  All agent calls are mocked — no API keys needed.

Goals:
  - Verify the full correct_addresses pipeline handles real-world messy
    Italian addresses (abbreviated cities, dashes, slashes, CAP suffixes, …)
  - Confirm that multi-location strings ("PINZOLO / SPIAZZO / …") come back
    in unresolved_names when the mock agent returns empty normalized_address
  - Ensure the corrected Excel is written correctly for both datasets
"""
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from address_corrector import FLAG_COL, AddressCorrector

# ---------------------------------------------------------------------------
# Paths to real fixture files
# ---------------------------------------------------------------------------
TESTS_DIR = Path(__file__).parent
REAL1_EXCEL = TESTS_DIR / "real1" / "input.xlsx"
REAL2_EXCEL = TESTS_DIR / "real2" / "input.xlsx"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_schools(excel_path: Path):
    """Mirror the DataLoader logic: read Nome/Indirizzo → name/address dicts."""
    df = pd.read_excel(excel_path)
    df.columns = [c.strip() for c in df.columns]
    schools = []
    for i, row in df.iterrows():
        schools.append({
            "id": i,
            "name": str(row["Nome"]).strip(),
            "address": str(row["Indirizzo"]).strip(),
            "demand": int(row.get("Partecipanti", 1) or 1),
            "institute": str(row.get("Istituto", "")) or None,
        })
    return schools


def _make_agent_response(schools, unresolved_names=None):
    """Build a realistic mock JSON response for the given school list.
    Schools whose name is in *unresolved_names* get an empty normalized_address.
    All others get a plausible OSM-formatted string.
    """
    unresolved_names = set(unresolved_names or [])
    items = []
    for s in schools:
        if s["name"] in unresolved_names:
            items.append({"name": s["name"], "normalized_address": ""})
        else:
            # Produce a simple but realistic OSM-style normalized form:
            # strip city prefixes in ALL-CAPS, normalize "TN" suffix, etc.
            addr = s["address"]
            items.append({"name": s["name"], "normalized_address": _normalize(addr)})
    return json.dumps(items, ensure_ascii=False)


def _normalize(raw: str) -> str:
    """Very simple mock 'normalization' that mimics what the real agent would do."""
    # Remove trailing ", Italia" if already there, then re-add
    addr = raw.replace(" TN,", ",").replace(" TN", "").replace("(TN)", "").strip()
    addr = addr.replace(" – ", ", ").replace(" - ", ", ")
    # Remove leading ALL-CAPS city token (e.g. "TRENTO Via …" → "Via …, Trento, …")
    tokens = addr.split()
    if tokens and tokens[0].isupper() and len(tokens[0]) > 3:
        city = tokens[0].title()
        addr = " ".join(tokens[1:]) + ", " + city
    addr = addr.strip(", ")
    return addr + ", Trentino-Alto Adige, Italia"


# ---------------------------------------------------------------------------
# Shared corrector fixture
# ---------------------------------------------------------------------------

@pytest.fixture
def corrector():
    c = AddressCorrector()
    c._enabled = True
    return c


# ---------------------------------------------------------------------------
# real1 — 20 schools, clean-ish addresses
# ---------------------------------------------------------------------------

class TestReal1Addresses:
    """Full pipeline tests with the real1 dataset (20 Trentino schools)."""

    UNRESOLVED = set()  # all addresses in real1 are individually resolvable

    @pytest.fixture(autouse=True)
    def setup(self, monkeypatch):
        monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
        monkeypatch.delenv("GOOGLE_API_KEY2", raising=False)
        monkeypatch.delenv("GOOGLE_API_KEY3", raising=False)
        monkeypatch.delenv("GOOGLE_API_KEY4", raising=False)

    def test_all_schools_corrected(self, corrector, tmp_path):
        schools = _load_schools(REAL1_EXCEL)
        response = _make_agent_response(schools, self.UNRESOLVED)
        output = tmp_path / "real1_corretto.xlsx"

        with patch("address_corrector.call_agent_with_key", return_value=response):
            result, status, unresolved = corrector.correct_addresses(
                schools, str(REAL1_EXCEL), str(output)
            )

        assert status == AddressCorrector.STATUS_OK
        assert unresolved == []
        assert len(result) == len(schools)
        # Every school address now ends with ", Trentino-Alto Adige, Italia"
        for s in result:
            assert s["address"].endswith(", Trentino-Alto Adige, Italia"), (
                f"{s['name']!r}: {s['address']!r}"
            )

    def test_corrected_excel_has_flag_and_all_rows(self, corrector, tmp_path):
        schools = _load_schools(REAL1_EXCEL)
        response = _make_agent_response(schools)
        output = tmp_path / "real1_corretto.xlsx"

        with patch("address_corrector.call_agent_with_key", return_value=response):
            corrector.correct_addresses(schools, str(REAL1_EXCEL), str(output))

        df = pd.read_excel(output)
        assert FLAG_COL in df.columns
        assert df[FLAG_COL].all()
        assert len(df) == len(schools)

    def test_agent_receives_correct_school_count(self, corrector, tmp_path):
        """Verify the agent is called with all 20 schools in real1."""
        schools = _load_schools(REAL1_EXCEL)
        response = _make_agent_response(schools)
        output = tmp_path / "out.xlsx"

        captured = {}
        def fake_agent(user_input, api_key):
            captured["payload"] = json.loads(user_input)
            return response

        with patch("address_corrector.call_agent_with_key", side_effect=fake_agent):
            corrector.correct_addresses(schools, str(REAL1_EXCEL), str(output))

        assert len(captured["payload"]) == 20
        assert all("name" in item and "address" in item for item in captured["payload"])

    def test_special_chars_in_address_handled(self, corrector, tmp_path):
        """real1 has dashes (–) and parentheses in Tione addresses — must not crash."""
        schools = _load_schools(REAL1_EXCEL)
        # Verify the addresses with special chars are present in the fixture
        tione_schools = [s for s in schools if "Tione" in s["address"] or "Guetti" in s["name"]]
        assert len(tione_schools) == 2

        response = _make_agent_response(schools)
        output = tmp_path / "out.xlsx"
        with patch("address_corrector.call_agent_with_key", return_value=response):
            _, status, unresolved = corrector.correct_addresses(
                schools, str(REAL1_EXCEL), str(output)
            )
        assert status == AddressCorrector.STATUS_OK


# ---------------------------------------------------------------------------
# real2 — 36 schools, messy/multi-location addresses
# ---------------------------------------------------------------------------

class TestReal2Addresses:
    """Full pipeline tests with the real2 dataset (36 Trentino schools).

    Several entries have slash-separated multi-location strings that a real
    geocoder cannot resolve to a single point — they come back unresolved.
    """

    # Addresses with "/" separator → agent cannot pick one location
    UNRESOLVED = {
        "IC Cembra",           # "CEMBRA Via Negritelle, 1 / GIOVO / SEGONZANO"
        "IC Centro Valsugana", # "TELVE Piazza Maggiore / RONCEGNO TERME"
        "IC Val Rendena",      # "PINZOLO / SPIAZZO / MADONNA DI CAMPIGLIO"
        "IC Aldeno-Mattarello",# "ALDENO Via Alle Albere / MATTARELLO"
    }

    @pytest.fixture(autouse=True)
    def setup(self, monkeypatch):
        monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
        monkeypatch.delenv("GOOGLE_API_KEY2", raising=False)
        monkeypatch.delenv("GOOGLE_API_KEY3", raising=False)
        monkeypatch.delenv("GOOGLE_API_KEY4", raising=False)

    def test_unresolved_multi_location_addresses(self, corrector, tmp_path):
        schools = _load_schools(REAL2_EXCEL)
        response = _make_agent_response(schools, self.UNRESOLVED)
        output = tmp_path / "real2_corretto.xlsx"

        with patch("address_corrector.call_agent_with_key", return_value=response):
            result, status, unresolved = corrector.correct_addresses(
                schools, str(REAL2_EXCEL), str(output)
            )

        assert status == AddressCorrector.STATUS_OK
        assert set(unresolved) == self.UNRESOLVED

    def test_unresolved_schools_have_empty_address(self, corrector, tmp_path):
        """Unresolved schools must have address='' so geocoding fails cleanly and
        the frontend orange banner can prompt the user for a manual replacement."""
        schools = _load_schools(REAL2_EXCEL)
        response = _make_agent_response(schools, self.UNRESOLVED)
        output = tmp_path / "real2_corretto.xlsx"

        with patch("address_corrector.call_agent_with_key", return_value=response):
            result, _, unresolved = corrector.correct_addresses(
                schools, str(REAL2_EXCEL), str(output)
            )

        for s in result:
            if s["name"] in self.UNRESOLVED:
                assert s["address"] == "", (
                    f"{s['name']!r} should have empty address, got {s['address']!r}"
                )

    def test_resolved_schools_get_normalized_address(self, corrector, tmp_path):
        schools = _load_schools(REAL2_EXCEL)
        response = _make_agent_response(schools, self.UNRESOLVED)
        output = tmp_path / "out.xlsx"

        with patch("address_corrector.call_agent_with_key", return_value=response):
            result, _, _ = corrector.correct_addresses(
                schools, str(REAL2_EXCEL), str(output)
            )

        resolved = [s for s in result if s["name"] not in self.UNRESOLVED]
        for s in resolved:
            assert s["address"].endswith(", Trentino-Alto Adige, Italia"), (
                f"{s['name']!r}: {s['address']!r}"
            )

    def test_corrected_excel_saved_for_resolved_schools(self, corrector, tmp_path):
        schools = _load_schools(REAL2_EXCEL)
        response = _make_agent_response(schools, self.UNRESOLVED)
        output = tmp_path / "real2_corretto.xlsx"

        with patch("address_corrector.call_agent_with_key", return_value=response):
            corrector.correct_addresses(schools, str(REAL2_EXCEL), str(output))

        df = pd.read_excel(output)
        assert FLAG_COL in df.columns
        assert df[FLAG_COL].all()
        assert len(df) == len(schools)

    def test_agent_receives_correct_school_count(self, corrector, tmp_path):
        """Verify the agent is called with all 36 schools in real2."""
        schools = _load_schools(REAL2_EXCEL)
        response = _make_agent_response(schools, self.UNRESOLVED)
        output = tmp_path / "out.xlsx"

        captured = {}
        def fake_agent(user_input, api_key):
            captured["payload"] = json.loads(user_input)
            return response

        with patch("address_corrector.call_agent_with_key", side_effect=fake_agent):
            corrector.correct_addresses(schools, str(REAL2_EXCEL), str(output))

        assert len(captured["payload"]) == 36
        # All items must use "name" field (not "id")
        assert all("name" in item for item in captured["payload"])
        assert not any("id" in item for item in captured["payload"])

    def test_parse_response_with_full_real2_dataset(self, corrector):
        """_parse_response handles all 36 schools, some with empty normalized_address."""
        schools = _load_schools(REAL2_EXCEL)
        raw = _make_agent_response(schools, self.UNRESOLVED)
        corrections, unresolved = corrector._parse_response(raw)

        assert len(corrections) == 36 - len(self.UNRESOLVED)
        assert set(unresolved) == self.UNRESOLVED
        # Spot-check a few resolved entries
        assert "IC Mori" in corrections
        assert "IC Primiero" in corrections
        assert "IS San Michele Agrario" in corrections
