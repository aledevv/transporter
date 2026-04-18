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

# TestAddressCorrectorCacheIntegration removed — _apply_cache_hits() was deleted
# when the name-based address cache was removed from AddressCorrector.
