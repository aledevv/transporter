"""
tests/test_school_cache.py
===========================
Tests for school_cache.py covering:
  1. get_exact()      — exact name match → bypass AI
  2. find_suggestion() — fuzzy match → suggest to user
  3. AddressCorrector integration — cache hits skip the AI call
"""
import json
import sys
import pytest
from pathlib import Path
from unittest.mock import MagicMock, patch

# Ensure project root is on path
sys.path.insert(0, str(Path(__file__).parent.parent))
import school_cache


# ── Fixtures ───────────────────────────────────────────────────────────────────

FAKE_CACHE = {
    "IC ALDENO MATTARELLO": "Via della Torre Franca, Mattarello, Trento, 38123, Italia",
    "IC CLES": "Piazza Fiera, 38028 Cles TN, Italia",
    "IC BRENTONICO": "Via Calzolari, Lera, Fontechel, Brentonico, Trento, 38060, Italia",
    "IS BUONARROTI": "Via Brigata Acqui, 2, Trento, 38122, Italia",
}


@pytest.fixture(autouse=True)
def inject_fake_cache(monkeypatch):
    """Replaces the on-disk cache with a controlled in-memory dict for all tests."""
    monkeypatch.setattr(school_cache, "_cache", dict(FAKE_CACHE))


# ── get_exact() ────────────────────────────────────────────────────────────────

class TestGetExact:
    def test_exact_match_returns_address(self):
        result = school_cache.get_exact("IC CLES")
        assert result == FAKE_CACHE["IC CLES"]

    def test_case_insensitive_match(self):
        result = school_cache.get_exact("ic cles")
        assert result == FAKE_CACHE["IC CLES"]

    def test_mixed_case(self):
        result = school_cache.get_exact("Ic Aldeno Mattarello")
        assert result == FAKE_CACHE["IC ALDENO MATTARELLO"]

    def test_unknown_name_returns_none(self):
        assert school_cache.get_exact("IC IGNOTO") is None

    def test_empty_string_returns_none(self):
        assert school_cache.get_exact("") is None


# ── find_suggestion() ──────────────────────────────────────────────────────────

class TestFindSuggestion:
    def test_high_name_similarity_gives_suggestion(self):
        # "IC Cles" is similar enough to "IC CLES"
        result = school_cache.find_suggestion("IC Cles", "PIAZZA FIERA - CLES")
        assert result is not None
        assert result["address"] == FAKE_CACHE["IC CLES"]
        assert result["score"] >= 0.7

    def test_similar_address_gives_suggestion(self):
        result = school_cache.find_suggestion(
            "SCUOLA BRENTONICO",  # name doesn't match well
            "Via Calzolari, Brentonico, TN",  # address is similar
        )
        assert result is not None
        assert "Brentonico" in result["address"]

    def test_same_address_not_suggested(self):
        """If the cached address equals the bad address exactly, don't suggest."""
        result = school_cache.find_suggestion(
            "IC CLES",
            FAKE_CACHE["IC CLES"],   # already the correct one
        )
        # Should return None (or a different entry) — not the same address
        if result is not None:
            assert result["address"] != FAKE_CACHE["IC CLES"]

    def test_low_similarity_returns_none(self):
        result = school_cache.find_suggestion("XYZ SCUOLA FANTASMA", "Via Inesistente, 99")
        assert result is None

    def test_score_field_present(self):
        result = school_cache.find_suggestion("IC BRENTONICO", "Via diversa, Brentonico")
        assert result is not None
        assert "score" in result
        assert 0 < result["score"] <= 1.0


# ── AddressCorrector integration ───────────────────────────────────────────────

class TestAddressCorrectorCacheIntegration:
    """
    Verifies that AddressCorrector._apply_cache_hits() returns corrections for
    schools whose names are in the cache, and that correct_addresses() calls
    the AI only for the non-cached schools.
    """

    def _make_schools(self, entries):
        """Helper: build a school list like the app produces from Excel."""
        return [
            {"id": i, "name": name, "address": addr, "demand": 10}
            for i, (name, addr) in enumerate(entries)
        ]

    def test_apply_cache_hits_returns_known_schools(self):
        from address_corrector import AddressCorrector
        schools = self._make_schools([
            ("IC CLES", "PIAZZA FIERA - CLES"),         # in cache, wrong address
            ("IC IGNOTO", "Via Roma, 1, Trento"),        # not in cache
        ])
        hits = AddressCorrector._apply_cache_hits(schools)
        assert "IC CLES" in hits
        assert hits["IC CLES"] == FAKE_CACHE["IC CLES"]
        assert "IC IGNOTO" not in hits

    def test_apply_cache_hits_skips_identical_address(self):
        from address_corrector import AddressCorrector
        schools = self._make_schools([
            ("IC CLES", FAKE_CACHE["IC CLES"]),   # already the cached address
        ])
        hits = AddressCorrector._apply_cache_hits(schools)
        # No correction needed — address is already correct
        assert "IC CLES" not in hits

    def test_correct_addresses_ai_skipped_for_cached(self):
        """
        When ALL schools are in cache, the AI (call_agent_with_key) must NOT be called.
        """
        from address_corrector import AddressCorrector

        schools = self._make_schools([
            ("IC CLES", "PIAZZA FIERA - CLES"),
            ("IC BRENTONICO", "Via Calzolari, 3, Brentonico TN"),
        ])

        corrector = AddressCorrector()
        corrector._enabled = True  # force enabled

        # Provide a fake Excel so the file-read doesn't fail
        import pandas as pd, tempfile, os
        df = pd.DataFrame({"Nome": [s["name"] for s in schools],
                           "Indirizzo": [s["address"] for s in schools]})
        with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as f:
            tmp_input = f.name
        with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as f:
            tmp_output = f.name
        df.to_excel(tmp_input, index=False)

        try:
            with patch("address_corrector.call_agent_with_key") as mock_ai:
                corrected, status, unresolved = corrector.correct_addresses(
                    schools, tmp_input, tmp_output
                )
            # AI must NOT have been called (all schools were in cache)
            mock_ai.assert_not_called()
            assert status == "ok"
            assert unresolved == []
            # Addresses must be the cached ones
            by_name = {s["name"]: s["address"] for s in corrected}
            assert by_name["IC CLES"] == FAKE_CACHE["IC CLES"]
            assert by_name["IC BRENTONICO"] == FAKE_CACHE["IC BRENTONICO"]
        finally:
            os.unlink(tmp_input)
            os.unlink(tmp_output)

    def test_correct_addresses_ai_called_only_for_uncached(self):
        """
        When one school is in cache and one is not, the AI is called only for
        the uncached one.
        """
        from address_corrector import AddressCorrector

        schools = self._make_schools([
            ("IC CLES", "PIAZZA FIERA - CLES"),        # in cache
            ("IC IGNOTO", "Via Roma, 1, Trento"),      # not in cache → needs AI
        ])

        corrector = AddressCorrector()
        corrector._enabled = True

        import pandas as pd, tempfile, os
        df = pd.DataFrame({"Nome": [s["name"] for s in schools],
                           "Indirizzo": [s["address"] for s in schools]})
        with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as f:
            tmp_input = f.name
        with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as f:
            tmp_output = f.name
        df.to_excel(tmp_input, index=False)

        ai_response = json.dumps([
            {"name": "IC IGNOTO", "normalized_address": "Via Roma, 1, Trento, TN, Italia"}
        ])

        try:
            with patch.object(corrector, "_call_with_fallback", return_value=ai_response):
                corrected, status, unresolved = corrector.correct_addresses(
                    schools, tmp_input, tmp_output
                )
            by_name = {s["name"]: s["address"] for s in corrected}
            # Cache school → cached address
            assert by_name["IC CLES"] == FAKE_CACHE["IC CLES"]
            # AI school → AI response address
            assert by_name["IC IGNOTO"] == "Via Roma, 1, Trento, TN, Italia"
        finally:
            os.unlink(tmp_input)
            os.unlink(tmp_output)
