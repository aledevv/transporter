"""Tests for AddressCorrector."""
import json
import os
from unittest.mock import MagicMock, call, patch

import pandas as pd
import pytest

from address_corrector import FLAG_COL, AddressCorrector
from tests.conftest import MOCK_AGENT_RESPONSE

RATE_LIMIT_EXC = Exception("429 RESOURCE_EXHAUSTED: quota exceeded")
GENERIC_EXC = RuntimeError("Connection refused")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def corrector():
    c = AddressCorrector()
    c._enabled = True
    return c


@pytest.fixture
def flagged_excel(tmp_path, sample_schools):
    path = tmp_path / "already_done.xlsx"
    df = pd.DataFrame([
        {"Nome": s["name"], "Indirizzo": s["address"], "Partecipanti": s["demand"], FLAG_COL: True}
        for s in sample_schools
    ])
    df.to_excel(path, index=False)
    return path


@pytest.fixture(autouse=True)
def primary_api_key(monkeypatch):
    """Ensure at least one API key is set so _call_with_fallback can proceed."""
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key-1")
    monkeypatch.delenv("GOOGLE_API_KEY2", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY3", raising=False)


# ---------------------------------------------------------------------------
# correct_addresses — happy path & skipping
# ---------------------------------------------------------------------------

class TestCorrectAddresses:
    def test_corrections_applied_to_returned_schools(
        self, corrector, sample_schools, sample_excel, tmp_path
    ):
        output = tmp_path / "out.xlsx"
        with patch("address_corrector.call_agent_with_key", return_value=MOCK_AGENT_RESPONSE):
            result, _ = corrector.correct_addresses(sample_schools, str(sample_excel), str(output))

        assert result[0]["address"] == "Via Roma, 1, 38100 Trento, Trentino, Italia"
        assert result[1]["address"] == "Piazza Dante, 3, Rovereto, Trentino, Italia"

    def test_returns_ok_status_on_success(
        self, corrector, sample_schools, sample_excel, tmp_path
    ):
        output = tmp_path / "out.xlsx"
        with patch("address_corrector.call_agent_with_key", return_value=MOCK_AGENT_RESPONSE):
            _, status = corrector.correct_addresses(sample_schools, str(sample_excel), str(output))
        assert status == AddressCorrector.STATUS_OK

    def test_corrected_excel_saved_with_flag(
        self, corrector, sample_schools, sample_excel, tmp_path
    ):
        output = tmp_path / "out_corretto.xlsx"
        with patch("address_corrector.call_agent_with_key", return_value=MOCK_AGENT_RESPONSE):
            corrector.correct_addresses(sample_schools, str(sample_excel), str(output))

        df = pd.read_excel(output)
        assert FLAG_COL in df.columns
        assert df[FLAG_COL].all()
        assert df.loc[0, "Indirizzo"] == "Via Roma, 1, 38100 Trento, Trentino, Italia"
        assert df.loc[1, "Indirizzo"] == "Piazza Dante, 3, Rovereto, Trentino, Italia"

    def test_original_columns_preserved_in_corrected_excel(
        self, corrector, sample_schools, sample_excel, tmp_path
    ):
        output = tmp_path / "out_corretto.xlsx"
        with patch("address_corrector.call_agent_with_key", return_value=MOCK_AGENT_RESPONSE):
            corrector.correct_addresses(sample_schools, str(sample_excel), str(output))

        df = pd.read_excel(output)
        for col in ("Nome", "Indirizzo", "Partecipanti", "Istituto"):
            assert col in df.columns

    def test_skip_when_already_flagged(
        self, corrector, sample_schools, flagged_excel, tmp_path
    ):
        output = tmp_path / "out.xlsx"
        mock_fn = MagicMock()
        with patch("address_corrector.call_agent_with_key", mock_fn):
            result, status = corrector.correct_addresses(sample_schools, str(flagged_excel), str(output))

        mock_fn.assert_not_called()
        assert result == sample_schools
        assert status == AddressCorrector.STATUS_SKIPPED_FLAGGED

    def test_partial_flag_does_not_skip(self, corrector, sample_schools, tmp_path):
        partial_excel = tmp_path / "partial.xlsx"
        df = pd.DataFrame([
            {"Nome": s["name"], "Indirizzo": s["address"], "Partecipanti": s["demand"], FLAG_COL: (i == 0)}
            for i, s in enumerate(sample_schools)
        ])
        df.to_excel(partial_excel, index=False)

        with patch("address_corrector.call_agent_with_key", return_value=MOCK_AGENT_RESPONSE) as mock_fn:
            _, status = corrector.correct_addresses(sample_schools, str(partial_excel), str(tmp_path / "out.xlsx"))

        mock_fn.assert_called_once()
        assert status == AddressCorrector.STATUS_OK

    def test_disabled_corrector_is_noop(self, sample_schools, sample_excel, tmp_path):
        corrector = AddressCorrector()
        corrector._enabled = False
        mock_fn = MagicMock()
        with patch("address_corrector.call_agent_with_key", mock_fn):
            result, status = corrector.correct_addresses(sample_schools, str(sample_excel), str(tmp_path / "out.xlsx"))

        mock_fn.assert_not_called()
        assert result == sample_schools
        assert status == AddressCorrector.STATUS_SKIPPED_DISABLED

    def test_fallback_on_generic_error(self, corrector, sample_schools, sample_excel, tmp_path):
        with patch("address_corrector.call_agent_with_key", side_effect=GENERIC_EXC):
            result, status = corrector.correct_addresses(sample_schools, str(sample_excel), str(tmp_path / "out.xlsx"))

        assert result == sample_schools
        assert status == AddressCorrector.STATUS_ERROR

    def test_fallback_on_invalid_json(self, corrector, sample_schools, sample_excel, tmp_path):
        with patch("address_corrector.call_agent_with_key", return_value="not valid json {{"):
            result, status = corrector.correct_addresses(sample_schools, str(sample_excel), str(tmp_path / "out.xlsx"))

        assert result == sample_schools
        assert status == AddressCorrector.STATUS_ERROR


# ---------------------------------------------------------------------------
# _call_with_fallback — key rotation logic
# ---------------------------------------------------------------------------

class TestCallWithFallback:
    @pytest.fixture(autouse=True)
    def three_keys(self, monkeypatch):
        monkeypatch.setenv("GOOGLE_API_KEY",  "key-1")
        monkeypatch.setenv("GOOGLE_API_KEY2", "key-2")
        monkeypatch.setenv("GOOGLE_API_KEY3", "key-3")

    def test_uses_primary_key_on_success(self, corrector):
        with patch("address_corrector.call_agent_with_key", return_value="ok") as mock_fn:
            result = corrector._call_with_fallback("input")

        assert result == "ok"
        mock_fn.assert_called_once_with("input", "key-1")

    def test_falls_back_to_second_key_on_rate_limit(self, corrector):
        mock_fn = MagicMock(side_effect=[RATE_LIMIT_EXC, "ok-from-key2"])
        with patch("address_corrector.call_agent_with_key", mock_fn):
            result = corrector._call_with_fallback("input")

        assert result == "ok-from-key2"
        assert mock_fn.call_count == 2
        assert mock_fn.call_args_list[0] == call("input", "key-1")
        assert mock_fn.call_args_list[1] == call("input", "key-2")

    def test_falls_back_to_third_key_when_first_two_exhausted(self, corrector):
        mock_fn = MagicMock(side_effect=[RATE_LIMIT_EXC, RATE_LIMIT_EXC, "ok-from-key3"])
        with patch("address_corrector.call_agent_with_key", mock_fn):
            result = corrector._call_with_fallback("input")

        assert result == "ok-from-key3"
        assert mock_fn.call_count == 3

    def test_raises_rate_limit_when_all_keys_exhausted(self, corrector):
        with patch("address_corrector.call_agent_with_key", side_effect=RATE_LIMIT_EXC):
            with pytest.raises(Exception, match="429"):
                corrector._call_with_fallback("input")

    def test_generic_error_does_not_try_next_key(self, corrector):
        mock_fn = MagicMock(side_effect=[GENERIC_EXC, "should-not-reach"])
        with patch("address_corrector.call_agent_with_key", mock_fn):
            with pytest.raises(RuntimeError, match="Connection refused"):
                corrector._call_with_fallback("input")

        mock_fn.assert_called_once()  # Stopped at first key

    def test_only_configured_keys_are_tried(self, corrector, monkeypatch):
        monkeypatch.delenv("GOOGLE_API_KEY3")  # Only 2 keys available
        mock_fn = MagicMock(side_effect=[RATE_LIMIT_EXC, "ok-from-key2"])
        with patch("address_corrector.call_agent_with_key", mock_fn):
            result = corrector._call_with_fallback("input")

        assert result == "ok-from-key2"
        assert mock_fn.call_count == 2

    def test_raises_when_no_keys_configured(self, corrector, monkeypatch):
        monkeypatch.delenv("GOOGLE_API_KEY")
        monkeypatch.delenv("GOOGLE_API_KEY2")
        monkeypatch.delenv("GOOGLE_API_KEY3")
        with patch("address_corrector.call_agent_with_key"):
            with pytest.raises(RuntimeError, match="No API keys"):
                corrector._call_with_fallback("input")

    def test_rate_limit_status_when_all_keys_exhausted_end_to_end(
        self, corrector, sample_schools, sample_excel, tmp_path
    ):
        """correct_addresses returns STATUS_RATE_LIMIT when all 3 keys are exhausted."""
        with patch("address_corrector.call_agent_with_key", side_effect=RATE_LIMIT_EXC):
            result, status = corrector.correct_addresses(
                sample_schools, str(sample_excel), str(tmp_path / "out.xlsx")
            )

        assert result == sample_schools
        assert status == AddressCorrector.STATUS_RATE_LIMIT


# ---------------------------------------------------------------------------
# _parse_response
# ---------------------------------------------------------------------------

class TestParseResponse:
    @pytest.fixture(autouse=True)
    def make_corrector(self):
        self.corrector = AddressCorrector()

    def test_parses_plain_json(self):
        raw = '[{"id": 0, "normalized_address": "Via Roma, 1, Trento"}]'
        assert self.corrector._parse_response(raw) == {0: "Via Roma, 1, Trento"}

    def test_strips_json_markdown_fence(self):
        raw = '```json\n[{"id": 0, "normalized_address": "Via Roma, 1, Trento"}]\n```'
        assert self.corrector._parse_response(raw) == {0: "Via Roma, 1, Trento"}

    def test_strips_plain_markdown_fence(self):
        raw = '```\n[{"id": 1, "normalized_address": "Piazza Dante, Rovereto"}]\n```'
        assert self.corrector._parse_response(raw) == {1: "Piazza Dante, Rovereto"}

    def test_multiple_items(self):
        raw = json.dumps([
            {"id": 0, "normalized_address": "Addr A"},
            {"id": 1, "normalized_address": "Addr B"},
        ])
        assert self.corrector._parse_response(raw) == {0: "Addr A", 1: "Addr B"}

    def test_raises_on_missing_normalized_address_key(self):
        raw = '[{"id": 0, "address": "Via Roma, 1"}]'
        with pytest.raises(KeyError):
            self.corrector._parse_response(raw)

    def test_empty_fields_cleaned_during_parse(self):
        raw = json.dumps([{"id": "Scuola A", "normalized_address": "Piazza, , , Campitello di Fassa, Trento, Italy"}])
        result = self.corrector._parse_response(raw)
        assert result == {"Scuola A": "Piazza, Campitello di Fassa, Trento, Italy"}


# ---------------------------------------------------------------------------
# _clean_address
# ---------------------------------------------------------------------------

class TestCleanAddress:
    @pytest.mark.parametrize("raw, expected", [
        ("Piazza, , , Campitello di Fassa, Trento, Italy",
         "Piazza, Campitello di Fassa, Trento, Italy"),
        ("Via Roma, 1, , 38100 Trento, , Italy",
         "Via Roma, 1, 38100 Trento, Italy"),
        ("Via Roma, 1, Trento, Italy",          # already clean
         "Via Roma, 1, Trento, Italy"),
        (",, ,",                                 # all empty
         ""),
        ("Trento",                               # single token, no commas
         "Trento"),
    ])
    def test_removes_empty_segments(self, raw, expected):
        assert AddressCorrector._clean_address(raw) == expected

    def test_strips_whitespace_around_segments(self):
        assert AddressCorrector._clean_address("Via Roma ,  1  ,  , Trento") == "Via Roma, 1, Trento"


# ---------------------------------------------------------------------------
# _classify_error
# ---------------------------------------------------------------------------

class TestClassifyError:
    @pytest.mark.parametrize("message", [
        "429 Too Many Requests",
        "RESOURCE_EXHAUSTED: quota exceeded",
        "ResourceExhausted",
        "rate limit reached",
        "daily quota exceeded",
    ])
    def test_rate_limit_signals(self, message):
        assert AddressCorrector._classify_error(Exception(message)) == AddressCorrector.STATUS_RATE_LIMIT

    @pytest.mark.parametrize("message", [
        "Connection refused",
        "Invalid JSON response",
        "Timeout",
        "Internal Server Error",
    ])
    def test_generic_errors(self, message):
        assert AddressCorrector._classify_error(Exception(message)) == AddressCorrector.STATUS_ERROR
